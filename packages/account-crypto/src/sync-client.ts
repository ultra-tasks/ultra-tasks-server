import { AccountApiError, AccountClient } from './account-client';
import { canonical, fingerprint, randomKey, utf8 } from './encoding';
import { decryptRecord, encryptRecord, grantKey, receiveKey } from './sharing';
import { sign, verify, type VaultSecrets } from './vault';
import { mergeRecord } from './sync-merge';
import {
  canHoldUpload,
  holdRejectedWrites,
  UploadBodySizeError,
  withUploadDraft,
} from './personal-upload-drafts';
import {
  hasDifferentTaskTimeLocation,
  preparePersonalTimeRebase,
  rebasePersonalTimeChange,
} from './personal-records';
import { verifyOwnershipChain, ownershipAcceptanceData } from './ownership';
import {
  validateSharedRecord,
  validateSharedHierarchy,
  type SharedTask,
} from './shared-project';
import type {
  DeviceCertificate,
  Invitation,
  LocalScope,
  Membership,
  Mutation,
  PlainHead,
  Recipient,
  Role,
  ScopeInfo,
  ScopeSnapshot,
  StateStorage,
  SyncState,
  SyncWrite,
  OwnershipOffer,
  OwnershipAcceptance,
} from './sync-types';

const unsigned = <T extends { signature: string }>(value: T): Omit<T, 'signature'> => {
  const rest: Omit<T, 'signature'> = { ...value };
  Reflect.deleteProperty(rest, 'signature');
  return rest;
};
const same = (a: unknown, b: unknown): boolean =>
  canonical(a ?? null) === canonical(b ?? null);
const SYNC_HISTORY_CHANGED =
  'Sync history changed. Verified data and pending edits were retained on this device.';
const assertHeadFollows = (held: PlainHead | undefined, next: PlainHead): void => {
  if (!held) return;
  if (next.revision < held.revision)
    throw new Error('Sync server returned an older record version');
  if (next.revision === held.revision && !same(held, next))
    throw new Error(SYNC_HISTORY_CHANGED);
};
const UPLOAD_BODY_LIMIT = 8 * 1024 * 1024;
// WebCrypto signs with a raw 64-byte P-256 signature, encoded without base64url padding.
const EMPTY_MUTATION_SIGNATURE = 'A'.repeat(86);
// Match the UTF-8 JSON sent by httpTransport, including the signature and wrapper.
const uploadBodyBytes = (value: object): number => utf8(JSON.stringify(value)).length;
export interface RecordChange {
  entityId: string;
  entityType: string;
  value: unknown;
  deleted?: boolean;
  restore?: boolean;
}

/** Durable encrypted records; callers hold one browser account lease while this client is open. */
export class SyncClient {
  private readonly localListeners = new Set<(scopeId: string) => void>();
  private readonly authenticatedMemberships = new Set<string>();
  private readonly authenticatedCertificates = new Set<string>();
  state!: SyncState;
  private readonly queues = new Map<string, Promise<unknown>>();
  private persistence: Promise<void> = Promise.resolve();
  private scopeErrors: Record<string, string> = {};
  constructor(
    readonly account: AccountClient,
    private readonly storage: StateStorage,
  ) {}
  private get secrets(): VaultSecrets {
    if (!this.account.unlocked) throw new Error('Unlock the account first');
    return this.account.unlocked.secrets;
  }
  private get serverId(): string {
    return this.account.identity().serverId;
  }
  private get accountId(): string {
    return this.account.identity().accountId;
  }
  private request<T>(path: string, body?: object): Promise<T> {
    return this.account.request<T>('/sync' + path, body);
  }
  private exclusive<T>(run: () => Promise<T>, key = 'metadata'): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(run);
    const tail = result.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }
  private save(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const saved = this.persistence.then(() => this.storage.save(snapshot));
    this.persistence = saved.catch(() => undefined);
    return saved;
  }
  subscribeLocal(listener: (scopeId: string) => void): () => void {
    this.localListeners.add(listener);
    return () => {
      this.localListeners.delete(listener);
    };
  }

  async init(): Promise<void> {
    this.state = (await this.storage.load())!;
    if (this.state) return;
    const keys = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const id = crypto.randomUUID();
    const certificate = {
      serverId: this.serverId,
      accountId: this.accountId,
      deviceId: id,
      publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
    };
    const signed: DeviceCertificate = {
      ...certificate,
      signature: await sign(this.secrets.signingPrivateKey, certificate),
    };
    this.state = {
      v: 2,
      device: {
        id,
        privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey),
        certificate: signed,
      },
      scopes: {},
      pins: {},
      migrations: {},
    };
    await this.save();
  }

  private async membership(
    scopeId: string,
    recipient: Recipient,
    role: Role,
    key: string,
    epoch: number,
    inviteId: string = crypto.randomUUID(),
  ): Promise<Membership> {
    const authorization = {
      serverId: this.serverId,
      scopeId,
      ownerId: this.accountId,
      accountId: recipient.id,
      role,
      epoch,
      inviteId,
      encryptionPublicKey: recipient.encryptionPublicKey,
      signingPublicKey: recipient.signingPublicKey,
      grant: await grantKey(recipient.encryptionPublicKey, key, {
        serverId: this.serverId,
        scopeId,
        recipientId: recipient.id,
        epoch,
      }),
    };
    return {
      authorization,
      signature: await sign(this.secrets.signingPrivateKey, authorization),
    };
  }
  private self(): Recipient {
    return {
      id: this.accountId,
      username: this.account.account?.username ?? null,
      encryptionPublicKey: this.account.bundle!.encryptionPublicKey,
      signingPublicKey: this.account.bundle!.signingPublicKey,
    };
  }
  private async adopt(info: ScopeInfo): Promise<LocalScope> {
    const previous = this.state.scopes[info.id];
    if (previous && previous.info.kind !== info.kind)
      throw new Error('Sync scope type changed');
    this.assertScopeBoundary(info);
    await verifyOwnershipChain(this.serverId, info, previous?.info);
    const pinned = this.state.pins[info.ownerId];
    const identity = await fingerprint(info.ownerKey);
    if (pinned && pinned !== identity) throw new Error('Project owner identity changed');
    if (
      info.ownerId === this.accountId &&
      !same(info.ownerKey, this.account.bundle!.signingPublicKey)
    )
      throw new Error('Account identity mismatch');
    if (info.members !== previous?.info.members)
      for (const membership of info.members)
        await this.verifyMembership(info, membership);
    const own = info.members.find(
      (member) => member.authorization.accountId === this.accountId,
    );
    if (!own) throw new Error('Project membership is unavailable');
    if (
      previous &&
      (info.generation < previous.info.generation ||
        info.epoch < previous.info.epoch ||
        info.controlVersion < previous.info.controlVersion ||
        (info.generation === previous.info.generation &&
          info.sequence < previous.info.sequence))
    )
      throw new Error(SYNC_HISTORY_CHANGED);
    const previousOwn = previous?.info.members.find(
      (m) => m.authorization.accountId === this.accountId,
    );
    const unchangedGrant =
      previous &&
      info.epoch === previous.info.epoch &&
      info.ownerId === previous.info.ownerId &&
      same(info.ownerKey, previous.info.ownerKey) &&
      same(own, previousOwn);
    const key = unchangedGrant
      ? previous.key
      : await receiveKey(this.secrets.encryptionPrivateKey, own.authorization.grant, {
          serverId: this.serverId,
          scopeId: info.id,
          recipientId: this.accountId,
          epoch: info.epoch,
        });
    this.assertScopeBoundary(info, key);
    if (this.state.pins[info.ownerId] && this.state.pins[info.ownerId] !== identity)
      throw new Error('Project owner identity changed');
    this.state.pins[info.ownerId] = identity;
    const local = previous ?? {
      info,
      key,
      counter: 0,
      heads: {},
      intents: [],
      conflicts: [],
    };
    local.key = key;
    local.revoked = false;
    // The committed download cursor advances only after all records authenticate.
    if (!previous) this.state.scopes[info.id] = local;
    return local;
  }
  private assertScopeBoundary(info: ScopeInfo, key?: string): void {
    if (!['personal', 'project'].includes(info.kind))
      throw new Error('Unsupported sync scope type');
    if (
      info.kind === 'personal' &&
      (info.ownerId !== this.accountId ||
        info.members.length !== 1 ||
        info.members[0].authorization.accountId !== this.accountId ||
        info.members[0].authorization.role !== 'owner' ||
        (key !== undefined && key !== this.secrets.personalKey))
    )
      throw new Error(
        'Personal sync must use your own private account key and membership',
      );
  }
  private async verifyMembership(scope: ScopeInfo, member: Membership): Promise<void> {
    const cacheKey = canonical({
      serverId: this.serverId,
      scopeId: scope.id,
      ownerId: scope.ownerId,
      ownerKey: scope.ownerKey,
      epoch: scope.epoch,
      member,
    });
    if (this.authenticatedMemberships.has(cacheKey)) return;
    const a = member.authorization;
    if (
      a.serverId !== this.serverId ||
      a.scopeId !== scope.id ||
      a.ownerId !== scope.ownerId ||
      a.epoch !== scope.epoch ||
      (a.role === 'owner') !== (a.accountId === scope.ownerId) ||
      !(await verify(scope.ownerKey, a, member.signature))
    )
      throw new Error('Project membership authentication failed');
    if (this.authenticatedMemberships.size >= 256)
      this.authenticatedMemberships.delete(
        this.authenticatedMemberships.values().next().value!,
      );
    this.authenticatedMemberships.add(cacheKey);
  }
  private async verifyCertificate(
    certificate: DeviceCertificate,
    signingKey: JsonWebKey,
  ): Promise<boolean> {
    const key = canonical({ certificate, signingKey });
    if (this.authenticatedCertificates.has(key)) return true;
    if (!(await verify(signingKey, unsigned(certificate), certificate.signature)))
      return false;
    if (this.authenticatedCertificates.size >= 256)
      this.authenticatedCertificates.delete(
        this.authenticatedCertificates.values().next().value!,
      );
    this.authenticatedCertificates.add(key);
    return true;
  }
  /** `base` is the verified state a delta overlays; validation then covers the result. */
  private async openSnapshot(
    value: ScopeSnapshot,
    key: string,
    base: Record<string, PlainHead> = {},
  ): Promise<Record<string, PlainHead>> {
    const scope = value.scope;
    const manifests = new Map(
      value.manifests.map((mutation) => [mutation.mutationId, mutation]),
    );
    for (const m of manifests.values()) {
      await this.verifyMembership(scope, m.membership);
      const c = m.certificate;
      if (
        m.serverId !== this.serverId ||
        m.scopeId !== scope.id ||
        m.epoch !== scope.epoch ||
        m.generation !== scope.generation ||
        m.controlVersion > scope.controlVersion ||
        m.membership.authorization.role === 'viewer' ||
        c.accountId !== m.membership.authorization.accountId ||
        c.deviceId !== m.deviceId ||
        c.serverId !== this.serverId ||
        !(await this.verifyCertificate(c, m.membership.authorization.signingPublicKey)) ||
        !(await verify(c.publicKey, unsigned(m), m.signature))
      )
        throw new Error('Transaction authentication failed');
    }
    const heads: Record<string, PlainHead> = {};
    for (const write of value.heads) {
      const h = write.record.header;
      const m = manifests.get(h.mutationId);
      if (
        !m ||
        !m.writes.some((w) => same(w, write)) ||
        h.serverId !== this.serverId ||
        h.scopeId !== scope.id ||
        h.epoch !== scope.epoch ||
        h.generation !== scope.generation ||
        h.actorId !== m.certificate.accountId ||
        h.deviceId !== m.deviceId ||
        h.counter !== m.counter ||
        h.controlVersion !== m.controlVersion ||
        heads[h.entityId]
      )
        throw new Error('Incomplete or substituted transaction');
      const payload = (await decryptRecord(
        write.record,
        h,
        key,
        m.certificate.publicKey,
      )) as { value: unknown; deleted: boolean };
      if (payload.deleted !== write.deleted)
        throw new Error('Tombstone authentication failed');
      if (scope.kind === 'project' && !payload.deleted)
        validateSharedRecord(h.entityType, payload.value);
      heads[h.entityId] = {
        entityId: h.entityId,
        entityType: h.entityType,
        revision: h.revision,
        value: payload.value,
        deleted: payload.deleted,
      };
    }
    for (const m of manifests.values())
      for (const write of m.writes) {
        if (
          !heads[write.record.header.entityId] ||
          heads[write.record.header.entityId].revision < write.record.header.revision
        )
          throw new Error('Server omitted part of an atomic transaction');
      }
    if (scope.kind === 'project')
      validateSharedHierarchy(
        Object.fromEntries(
          Object.values({ ...base, ...heads })
            .filter((h) => !h.deleted && h.entityType === 'shared.task')
            .map((h) => [h.entityId, h.value as SharedTask]),
        ),
      );
    return heads;
  }

  async refreshScopes(): Promise<ScopeInfo[]> {
    return this.exclusive(async () => {
      const before = Object.fromEntries(
        Object.entries(this.state.scopes).map(([id, scope]) => [id, scope.info]),
      );
      const { scopes } = await this.request<{ scopes: ScopeInfo[] }>('/scopes');
      const known = new Set(scopes.map((scope) => scope.id));
      this.scopeErrors = {};
      const valid = await Promise.all(
        scopes.map((scope) =>
          this.exclusive(async () => {
            try {
              const current = this.state.scopes[scope.id];
              // The list request may precede a concurrently completed scope download.
              // Keep that authenticated newer result; never apply stale control to it.
              if (
                current &&
                current.info !== before[scope.id] &&
                (scope.epoch < current.info.epoch ||
                  scope.controlVersion < current.info.controlVersion ||
                  scope.generation < current.info.generation ||
                  scope.sequence < current.info.sequence)
              )
                return current.info;
              const local = await this.adopt(scope);
              this.preserveInterruptedSetup(local, scope);
              return scope;
            } catch (error) {
              this.scopeErrors[scope.id] =
                error instanceof Error ? error.message : 'Scope authentication failed';
              return null;
            }
          }, scope.id),
        ),
      );
      await Promise.all(
        Object.values(this.state.scopes)
          .filter((scope) => !known.has(scope.info.id))
          .map((scope) => {
            if (scope.info.kind === 'personal' && scope.info.state === 'active') {
              this.scopeErrors[scope.info.id] = SYNC_HISTORY_CHANGED;
              return;
            }
            return this.markRevoked(scope.info.id);
          }),
      );
      await this.save();
      return valid.filter((scope): scope is ScopeInfo => scope !== null);
    });
  }
  async createScope(kind: 'personal' | 'project', migrating = false): Promise<string> {
    return this.exclusive(() =>
      this.createScopeWithId(crypto.randomUUID(), kind, migrating),
    );
  }
  private async createScopeWithId(
    id: string,
    kind: 'personal' | 'project',
    migrating: boolean,
    replacesEmptyScopeId?: string,
  ): Promise<string> {
    const key = kind === 'personal' ? this.secrets.personalKey : randomKey();
    const info = await this.request<ScopeInfo>('/scopes', {
      kind,
      deviceId: this.state.device.id,
      migrating,
      ...(replacesEmptyScopeId ? { replacesEmptyScopeId } : {}),
      membership: await this.membership(id, this.self(), 'owner', key, 1),
    });
    const local = await this.adopt(info);
    local.info = info;
    await this.save();
    return info.id;
  }
  async edit(scopeId: string, changes: RecordChange[]): Promise<void> {
    return this.exclusive(() => this.queueEdit(scopeId, changes), 'local');
  }
  private async queueEdit(scopeId: string, changes: RecordChange[]): Promise<void> {
    const scope = this.state.scopes[scopeId];
    if (!scope) throw new Error('Download the project first');
    this.assertScopeBoundary(scope.info, scope.key);
    if (scope.revoked)
      throw new Error(
        'Project access was revoked; export private drafts before discarding them',
      );
    const role = scope.info.members.find(
      (m) => m.authorization.accountId === this.accountId,
    )?.authorization.role;
    if (role === 'viewer') throw new Error('Viewers cannot change shared content');
    if (scope.info.kind === 'project')
      for (const change of changes)
        if (!change.deleted) validateSharedRecord(change.entityType, change.value);
    if (
      !changes.length ||
      changes.length > 100 ||
      new Set(changes.map((c) => c.entityId)).size !== changes.length
    )
      throw new Error('An intent must contain 1–100 distinct records');
    const projected = this.projectedRecords(scope, false);
    if (scope.info.kind === 'project') {
      const next = {
        ...projected,
        ...Object.fromEntries(changes.map((c) => [c.entityId, c])),
      };
      validateSharedHierarchy(
        Object.fromEntries(
          Object.entries(next)
            .filter(([, h]) => !h.deleted && h.entityType === 'shared.task')
            .map(([id, h]) => [id, h.value as SharedTask]),
        ),
      );
    }
    scope.intents.push({
      id: crypto.randomUUID(),
      changes: changes.map((c) => ({
        ...c,
        deleted: c.deleted ?? false,
        ...(c.restore ? { restore: true } : {}),
        base: projected[c.entityId] ?? null,
      })),
    });
    await this.save();
    for (const listener of this.localListeners) listener(scopeId);
  }
  records(scopeId: string, includeDeleted = false): Record<string, PlainHead> {
    const scope = this.state.scopes[scopeId];
    if (!scope) return {};
    const heads = this.projectedRecords(scope, true);
    return includeDeleted
      ? heads
      : Object.fromEntries(Object.entries(heads).filter(([, h]) => !h.deleted));
  }
  private projectedRecords(
    scope: LocalScope,
    showUploadDrafts: boolean,
  ): Record<string, PlainHead> {
    const heads = structuredClone(scope.heads);
    if (showUploadDrafts) {
      for (const draft of scope.conflicts) {
        if (draft.reason !== 'upload') continue;
        const projected = withUploadDraft(heads[draft.entityId], draft);
        if (projected) heads[draft.entityId] = projected;
      }
    }
    for (const intent of scope.intents)
      for (const c of intent.changes)
        heads[c.entityId] = {
          entityId: c.entityId,
          entityType: c.entityType,
          revision: heads[c.entityId]?.revision ?? 0,
          deleted: c.deleted,
          value: c.value,
        };
    return heads;
  }
  /** Forget only a personal cache after the caller has preserved its verified and pending data. */
  async detachPersonalForRecovery(
    scopeId: string,
    preserve: (archive: unknown) => Promise<boolean>,
  ): Promise<boolean> {
    return this.exclusive(
      () =>
        this.exclusive(async () => {
          const scope = this.state.scopes[scopeId];
          if (scope?.info.kind !== 'personal')
            throw new Error('Personal data is unavailable');
          this.assertScopeBoundary(scope.info, scope.key);
          const migration = this.state.migrations[scopeId];
          if (migration && !migration.complete && !migration.interruptedOutbox)
            throw new Error('Finish the personal migration before reconnecting');
          const archive = structuredClone({
            format: 'ultra-tasks-personal-sync-recovery-v1',
            scopeId,
            sequence: scope.info.sequence,
            generation: scope.info.generation,
            acknowledged: scope.heads,
            pending: scope.intents,
            conflictDrafts: scope.conflicts,
            ...(migration?.interruptedOutbox
              ? {
                  interruptedSetup: {
                    records: migration.records,
                    outbox: { intents: migration.interruptedOutbox.intents },
                  },
                }
              : {}),
          });
          if (!(await preserve(archive))) return false;
          delete this.state.scopes[scopeId];
          delete this.state.migrations[scopeId];
          try {
            await this.save();
          } catch (error) {
            this.state.scopes[scopeId] = scope;
            if (migration) this.state.migrations[scopeId] = migration;
            throw error;
          }
          return true;
        }, scopeId),
      'local',
    );
  }
  async dismissDrafts(scopeId: string): Promise<void> {
    return this.exclusive(async () => {
      const scope = this.state.scopes[scopeId];
      // A held upload is an editable local value, even when conflict drafts are dismissed.
      scope.conflicts = scope.conflicts.filter((draft) => draft.reason === 'upload');
      if (this.state.scopes[scopeId].revoked) {
        this.state.scopes[scopeId].intents = [];
        delete this.state.scopes[scopeId].uncertain;
        delete this.state.scopes[scopeId].uncertainKey;
      }
      await this.save();
    }, scopeId);
  }
  async markRevoked(scopeId: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.state.scopes[scopeId]) this.state.scopes[scopeId].revoked = true;
      await this.save();
    }, scopeId);
  }
  record(scopeId: string, entityId: string): PlainHead | undefined {
    const scope = this.state.scopes[scopeId];
    let head: PlainHead | undefined = scope?.heads[entityId];
    const draft = scope?.conflicts.find(
      (entry) => entry.reason === 'upload' && entry.entityId === entityId,
    );
    if (draft?.reason === 'upload') head = withUploadDraft(head, draft);
    for (const intent of scope?.intents ?? [])
      for (const change of intent.changes)
        if (change.entityId === entityId)
          head = {
            entityId,
            entityType: change.entityType,
            revision: head?.revision ?? 0,
            value: change.value,
            deleted: change.deleted,
          };
    return head && !head.deleted ? structuredClone(head) : undefined;
  }
  private async mutation(
    scope: LocalScope,
    changes: RecordChange[],
    key = scope.key,
    info = scope.info,
  ): Promise<Mutation> {
    if (info.kind === 'project' && info.state !== 'rotating') {
      const projected = {
        ...scope.heads,
        ...Object.fromEntries(changes.map((c) => [c.entityId, c])),
      };
      validateSharedHierarchy(
        Object.fromEntries(
          Object.entries(projected)
            .filter(([, h]) => !h.deleted && h.entityType === 'shared.task')
            .map(([id, h]) => [id, h.value as SharedTask]),
        ),
      );
    }
    const mutationId = crypto.randomUUID();
    const counter = scope.counter + 1;
    const data: Omit<Mutation, 'signature'> = {
      v: 2,
      serverId: this.serverId,
      scopeId: info.id,
      epoch: info.epoch,
      generation: info.generation,
      controlVersion: info.controlVersion,
      deviceId: this.state.device.id,
      counter,
      mutationId,
      certificate: this.state.device.certificate,
      membership: info.members.find((m) => m.authorization.accountId === this.accountId)!,
      writes: [],
    };
    const encryptWrite = async (change: RecordChange): Promise<SyncWrite> => {
      const baseRevision = scope.heads[change.entityId]?.revision ?? 0;
      return {
        record: await encryptRecord(
          {
            v: 2,
            serverId: data.serverId,
            scopeId: data.scopeId,
            entityId: change.entityId,
            entityType: change.entityType,
            actorId: this.accountId,
            deviceId: data.deviceId,
            mutationId: data.mutationId,
            epoch: data.epoch,
            generation: data.generation,
            controlVersion: data.controlVersion,
            counter: data.counter,
            baseRevision,
            revision: baseRevision + 1,
          },
          { value: change.value, deleted: change.deleted ?? false },
          key,
          this.state.device.privateKey,
        ),
        deleted: change.deleted ?? false,
        ...(change.restore ? { restore: true } : {}),
      };
    };
    if (info.kind === 'personal') {
      // Encrypt only enough writes for this transaction. Later writes use the next counter.
      let bytes = uploadBodyBytes({ ...data, signature: EMPTY_MUTATION_SIGNATURE });
      for (const change of changes) {
        const write = await encryptWrite(change);
        bytes += uploadBodyBytes(write) + (data.writes.length ? 1 : 0);
        if (bytes > UPLOAD_BODY_LIMIT) break;
        data.writes.push(write);
      }
      if (!data.writes.length) throw new UploadBodySizeError();
    } else {
      data.writes = await Promise.all(changes.map(encryptWrite));
    }
    const signature = await sign(this.state.device.privateKey, data);
    if (signature.length !== EMPTY_MUTATION_SIGNATURE.length)
      throw new Error('Unexpected transaction signature length');
    return { ...data, signature };
  }
  private rebase(
    scope: LocalScope,
    remote: Record<string, PlainHead>,
    sameGeneration = true,
  ): void {
    const projected = structuredClone(remote);
    const taskLocations =
      scope.info.kind === 'personal' && scope.intents.length
        ? preparePersonalTimeRebase(remote, sameGeneration ? scope.intents : [])
        : undefined;
    if (taskLocations && !sameGeneration) {
      // A replacement may omit a timer bucket that never reached the server.
      // Keep the old-location edit as a draft instead of merging it into the replacement.
      for (const intent of scope.intents)
        intent.changes = intent.changes.filter((change) => {
          if (
            change.base ||
            remote[change.entityId] ||
            !hasDifferentTaskTimeLocation(change, taskLocations)
          )
            return true;
          this.draft(scope, change.entityId, change.value, 'deleted');
          return false;
        });
      scope.intents = scope.intents.filter((intent) => intent.changes.length);
    }
    for (const intent of scope.intents) {
      for (const c of intent.changes) {
        const target = projected[c.entityId];
        if (taskLocations && sameGeneration)
          rebasePersonalTimeChange(c, target, remote[c.entityId], taskLocations);
        if (
          target?.deleted &&
          !c.deleted &&
          !(c.restore && c.base?.deleted && c.base.revision === target.revision)
        ) {
          this.draft(scope, c.entityId, c.value, 'deleted');
          c.deleted = true;
          delete c.restore;
          c.value = null;
        } else if (!c.deleted) {
          const merged = mergeRecord(c.base?.value, c.value, target?.value);
          if (merged.conflict) this.draft(scope, c.entityId, c.value, 'overlap');
          c.value = merged.value;
        }
        c.base = target ?? null;
        projected[c.entityId] = {
          entityId: c.entityId,
          entityType: c.entityType,
          value: c.value,
          deleted: c.deleted,
          revision: target?.revision ?? 0,
        };
      }
    }
    scope.heads = remote;
  }
  private draft(
    scope: LocalScope,
    entityId: string,
    value: unknown,
    reason: 'deleted' | 'overlap' | 'permission',
  ): void {
    if (scope.conflicts.filter((d) => d.entityId === entityId).length >= 20)
      throw new Error('Export and resolve conflict drafts before syncing this record');
    scope.conflicts.push({
      id: crypto.randomUUID(),
      entityId,
      value,
      reason,
      createdAt: Date.now(),
    });
  }
  private async acknowledge(scope: LocalScope, alreadyCommitted = false): Promise<void> {
    const mutation = scope.uncertain!;
    const receipt = alreadyCommitted
      ? undefined
      : await this.request<{ sequence: number }>(
          `/scopes/${scope.info.id}/transactions`,
          mutation,
        );
    for (const write of mutation.writes) {
      const h = write.record.header;
      const payload = (await decryptRecord(
        write.record,
        h,
        scope.uncertainKey ?? scope.key,
        mutation.certificate.publicKey,
      )) as { value: unknown; deleted: boolean };
      scope.heads[h.entityId] = {
        entityId: h.entityId,
        entityType: h.entityType,
        revision: h.revision,
        ...payload,
      };
    }
    scope.counter = mutation.counter;
    const uploaded = new Set(
      mutation.writes.map((write) => write.record.header.entityId),
    );
    scope.conflicts = scope.conflicts.filter(
      (draft) => draft.reason !== 'upload' || !uploaded.has(draft.entityId),
    );
    // Do not advance the download cursor: other devices may have committed first.
    void receipt;
    scope.intents.shift();
    delete scope.uncertain;
    delete scope.uncertainKey;
    await this.save();
  }
  async syncScope(scopeId: string): Promise<void> {
    return this.exclusive(() => this.sync(scopeId), scopeId);
  }
  private async resolveRejectedAttempt(
    scope: LocalScope,
    error: unknown,
  ): Promise<boolean> {
    if (
      canHoldUpload(scope) &&
      error instanceof AccountApiError &&
      error.status === 422 &&
      error.code === 'SYNC_RECORD_TOO_LARGE'
    ) {
      const mutation = scope.uncertain!;
      const writes = mutation.writes;
      const intent = scope.intents[0];
      const indices = new Set(error.writeIndices);
      if (
        !indices.size ||
        [...indices].some(
          (index) => !Number.isInteger(index) || index < 0 || index >= writes.length,
        ) ||
        intent?.changes.length !== writes.length ||
        writes.some(
          (write, index) =>
            write.record.header.entityId !== intent.changes[index].entityId,
        )
      )
        throw error;
      // An old attempt can be committed even when a newer retry is rejected.
      const receipt = await this.receipt(scope);
      if (
        receipt.mutationId === mutation.mutationId &&
        receipt.counter === mutation.counter
      ) {
        await this.acknowledge(scope, true);
        return true;
      }
      if (receipt.counter !== mutation.counter - 1) throw error;
      holdRejectedWrites(scope, indices);
      await this.save();
      return true;
    }
    if (![403, 409].includes((error as { status?: number }).status ?? 0)) throw error;
    await this.reconcileReceipt(scope);
    return false;
  }
  private async receipt(
    scope: LocalScope,
  ): Promise<{ counter: number; mutationId: string | null }> {
    const observedHistory =
      scope.info.kind === 'personal' && scope.downloaded
        ? `&after=${scope.info.sequence}` +
          (scope.cursorMutationId
            ? '&afterMutation=' + encodeURIComponent(scope.cursorMutationId)
            : '')
        : '';
    const receipt = await this.request<{ counter: number; mutationId: string | null }>(
      `/scopes/${scope.info.id}/receipt?deviceId=${this.state.device.id}` +
        observedHistory,
    );
    if (receipt.counter < scope.counter) throw new Error(SYNC_HISTORY_CHANGED);
    return receipt;
  }
  private async reconcileReceipt(
    scope: LocalScope,
    requirePredecessor = false,
  ): Promise<void> {
    const mutation = scope.uncertain!;
    const receipt = await this.receipt(scope);
    if (
      receipt.mutationId === mutation.mutationId &&
      receipt.counter === mutation.counter
    ) {
      await this.acknowledge(scope, true);
      return;
    }
    if (requirePredecessor && receipt.counter !== mutation.counter - 1)
      throw new Error(
        'Could not confirm the oversized transaction; local changes remain queued',
      );
    scope.counter = receipt.counter;
    delete scope.uncertain;
    delete scope.uncertainKey;
    await this.save();
  }
  private async sync(scopeId: string): Promise<void> {
    let scope = this.state.scopes[scopeId];
    if (!scope) throw new Error('Unknown sync scope');
    this.assertScopeBoundary(scope.info, scope.key);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (scope.uncertain) {
        if (
          scope.info.kind === 'personal' &&
          uploadBodyBytes(scope.uncertain) > UPLOAD_BODY_LIMIT
        ) {
          // An older client may already have saved a signed body the server cannot parse.
          await this.reconcileReceipt(scope, true);
        } else {
          // A persisted personal write must not replay onto a confirmed restored fork.
          if (scope.info.kind === 'personal' && scope.downloaded)
            await this.receipt(scope);
          // The last attempt may have failed to save before sending. Persist again before retrying.
          await this.save();
          try {
            await this.acknowledge(scope);
          } catch (error) {
            await this.resolveRejectedAttempt(scope, error);
          }
        }
      }
      const response = await this.request<
        | ScopeSnapshot
        | {
            scope: ScopeInfo;
            unchanged: true;
            controlUnchanged?: boolean;
            cursorMutationId?: string | null;
          }
      >(
        scope.downloaded
          ? `/scopes/${scopeId}/changes?after=${scope.info.sequence}&generation=${scope.info.generation}&controlVersion=${scope.info.controlVersion}&delta=1` +
              (scope.cursorMutationId
                ? '&afterMutation=' + encodeURIComponent(scope.cursorMutationId)
                : '') +
              (scope.counter
                ? `&deviceId=${this.state.device.id}&afterCounter=${scope.counter}`
                : '')
          : `/scopes/${scopeId}/snapshot`,
      );
      const previous = scope.info;
      if (response.controlUnchanged) {
        const next = response.scope;
        if (
          next.controlVersion !== previous.controlVersion ||
          next.epoch !== previous.epoch ||
          next.generation !== previous.generation ||
          next.ownerId !== previous.ownerId ||
          !same(next.ownerKey, previous.ownerKey) ||
          !same(next.ownershipChain ?? [], previous.ownershipChain ?? [])
        )
          throw new Error('Compact control does not match the authenticated project');
        response.scope.members = previous.members;
      }
      scope = await this.adopt(response.scope);
      this.preserveInterruptedSetup(scope, response.scope);
      if ('heads' in response && response.delta) {
        // Servers without incremental changes ignore the request and send a full snapshot.
        if (
          response.scope.generation !== previous.generation ||
          response.scope.epoch !== previous.epoch
        )
          throw new Error('Incremental changes cannot cross a key update');
        const changed = await this.openSnapshot(response, scope.key, scope.heads);
        for (const head of Object.values(changed))
          assertHeadFollows(scope.heads[head.entityId], head);
        this.rebase(scope, { ...scope.heads, ...changed });
      } else if ('heads' in response) {
        const remote = await this.openSnapshot(response, scope.key);
        // Within one generation heads are never removed and revisions only grow, so a
        // complete snapshot must still contain everything this device verified before.
        if (scope.downloaded && response.scope.generation === previous.generation)
          for (const held of Object.values(scope.heads)) {
            const current = remote[held.entityId];
            if (!current)
              throw new Error('Sync server omitted a record this device already has');
            assertHeadFollows(held, current);
          }
        this.rebase(scope, remote, response.scope.generation === previous.generation);
        scope.downloaded = true;
      } else if (previous.epoch !== response.scope.epoch)
        throw new Error('Key update requires a complete snapshot');
      scope.info = response.scope;
      if ('cursorMutationId' in response)
        scope.cursorMutationId = response.cursorMutationId ?? undefined;
      if (
        scope.info.kind === 'project' &&
        scope.info.members.find((m) => m.authorization.accountId === this.accountId)
          ?.authorization.role === 'viewer'
      ) {
        for (const intent of scope.intents)
          for (const change of intent.changes)
            this.draft(scope, change.entityId, change.value, 'permission');
        scope.intents = [];
      }
      await this.save();
      if (scope.info.state === 'rotating') {
        if (
          (scope.info.rotation?.controllerId ?? scope.info.ownerId) === this.accountId
        ) {
          await this.resumeRotation(scope);
          continue;
        }
        return;
      }
      if (!scope.intents.length) return;
      while (scope.intents.length) {
        const intent = scope.intents[0];
        let mutation: Mutation;
        try {
          mutation = await this.mutation(scope, intent.changes);
        } catch (error) {
          if (!(error instanceof UploadBodySizeError) || !canHoldUpload(scope))
            throw error;
          // The first write alone overflowed the HTTP budget. It was never sent.
          holdRejectedWrites(scope, new Set([0]));
          await this.save();
          continue;
        }
        if (mutation.writes.length < intent.changes.length) {
          const remaining = intent.changes.splice(mutation.writes.length);
          scope.intents.splice(1, 0, { id: crypto.randomUUID(), changes: remaining });
        }
        // Save the exact signed prefix and both intent parts together before sending.
        scope.uncertain = mutation;
        scope.uncertainKey = scope.key;
        await this.save();
        try {
          await this.acknowledge(scope);
        } catch (error) {
          if (!(await this.resolveRejectedAttempt(scope, error))) break;
        }
      }
      if (!scope.intents.length) return;
    }
    throw new Error('Concurrent changes are still arriving; local changes remain queued');
  }
  async syncAll(): Promise<Record<string, string>> {
    const infos = await this.refreshScopes();
    const errors: Record<string, string> = { ...this.scopeErrors };
    for (const scope of infos) {
      try {
        await this.syncScope(scope.id);
        if (scope.ownerId === this.accountId && scope.kind === 'project')
          await this.provision(scope.id);
      } catch (error) {
        errors[scope.id] = error instanceof Error ? error.message : 'Sync failed';
      }
    }
    return errors;
  }

  private preserveInterruptedSetup(scope: LocalScope, info: ScopeInfo): void {
    if (info.interruptedMigrationSource !== this.state.device.id) return;
    const journal = (this.state.migrations[info.id] ??= {
      scopeId: info.id,
      records: [],
      offset: 0,
      complete: false,
    });
    if (journal.interruptedOutbox) return;
    // Keep the original seed inventory and exact unsigned/uncertain queues in the
    // encrypted store. They must not become automatic edits of the recovered workspace.
    journal.interruptedOutbox = {
      intents: scope.intents,
      ...(scope.uncertain ? { uncertain: scope.uncertain } : {}),
      ...(scope.uncertainKey ? { uncertainKey: scope.uncertainKey } : {}),
    };
    scope.intents = [];
    delete scope.uncertain;
    delete scope.uncertainKey;
  }

  async recoverUploadedPersonalSetup(scopeId: string): Promise<void> {
    await this.syncScope(scopeId);
    const scope = this.state.scopes[scopeId];
    if (scope.info.kind !== 'personal') throw new Error('Personal setup required');
    if (scope.info.state === 'active') return;
    if (
      scope.info.state !== 'migrating' ||
      !scope.info.sequence ||
      !scope.cursorMutationId
    )
      throw new Error('There is no verified setup data to recover');
    const observed = {
      deviceId: this.state.device.id,
      controlVersion: scope.info.controlVersion,
      sequence: scope.info.sequence,
      cursorMutationId: scope.cursorMutationId,
    };
    await this.request('/scopes/' + scopeId + '/migration/recover', {
      ...observed,
      signature: await sign(this.secrets.signingPrivateKey, {
        action: 'recover-personal-migration',
        serverId: this.serverId,
        scopeId,
        ...observed,
      }),
    });
    await this.syncScope(scopeId);
  }

  /** Called after the original device persists its own data choice. */
  async rejoinRecoveredPersonalSetup(scopeId: string): Promise<void> {
    const scope = this.state.scopes[scopeId];
    if (scope?.info.interruptedMigrationSource !== this.state.device.id) return;
    const info = (await this.refreshScopes()).find((entry) => entry.id === scopeId);
    if (!info) throw new Error('Could not verify the recovered workspace');
    if (info.interruptedMigrationSource !== this.state.device.id) return;
    await this.exclusive(async () => {
      const current = this.state.scopes[scopeId];
      // The abandoned outbox may contain the lost reply for a committed write.
      current.counter = (await this.receipt(current)).counter;
      await this.save();
      const observed = {
        deviceId: this.state.device.id,
        controlVersion: info.controlVersion,
      };
      await this.request('/scopes/' + scopeId + '/migration/rejoin', {
        ...observed,
        signature: await sign(this.secrets.signingPrivateKey, {
          action: 'rejoin-personal-migration',
          serverId: this.serverId,
          scopeId,
          ...observed,
        }),
      });
    }, scopeId);
  }

  async migrate(records: RecordChange[]): Promise<string> {
    return this.runMigration(records);
  }
  async restartPersonalMigration(
    scopeId: string,
    records: RecordChange[],
  ): Promise<string> {
    return this.runMigration(records, scopeId);
  }
  private async runMigration(
    records: RecordChange[],
    replacesEmptyScopeId?: string,
  ): Promise<string> {
    return this.exclusive(async () => {
      let journal = Object.values(this.state.migrations).find((entry) => {
        const scope = this.state.scopes[entry.scopeId];
        if (entry.complete || entry.interruptedOutbox || scope?.revoked) return false;
        return replacesEmptyScopeId !== undefined
          ? entry.replacesEmptyScopeId === replacesEmptyScopeId
          : !entry.replacesEmptyScopeId || !!scope;
      });
      if (!journal) {
        const scopeId = crypto.randomUUID();
        journal = {
          scopeId,
          records: structuredClone(records),
          offset: 0,
          complete: false,
          ...(replacesEmptyScopeId ? { replacesEmptyScopeId } : {}),
        };
        this.state.migrations[scopeId] = journal;
      }
      const { scopeId, replacesEmptyScopeId: abandonedScopeId } = journal;
      // Store the intended scope ID and inventory before the server can create the scope.
      await this.save();
      if (!this.state.scopes[scopeId]) {
        const created = await this.exclusive(() =>
          this.createScopeWithId(scopeId, 'personal', true, abandonedScopeId),
        );
        if (created !== scopeId) {
          delete this.state.migrations[scopeId];
          await this.save();
          throw new Error(
            'This account already has personal data; connect without importing',
          );
        }
      }
      if (abandonedScopeId && this.state.scopes[abandonedScopeId])
        await this.markRevoked(abandonedScopeId);
      const scope = this.state.scopes[scopeId];
      if (
        scope.revoked ||
        scope.info.kind !== 'personal' ||
        (scope.info.state !== 'migrating' && journal.offset < journal.records.length)
      )
        throw new Error(
          'This account already has personal data; connect without importing',
        );

      while (journal.offset < journal.records.length) {
        const batch = journal.records.slice(journal.offset, journal.offset + 100);
        await this.exclusive(
          () =>
            this.exclusive(async () => {
              if (journal.interruptedOutbox)
                throw new Error(
                  'Setup was recovered on another device. Choose which data to use.',
                );
              if (scope.intents.length) return;
              // A crash can happen after the upload is acknowledged but before its offset is saved.
              const pending = batch.filter((record) => {
                const head = scope.heads[record.entityId];
                return (
                  !head ||
                  head.deleted ||
                  head.entityType !== record.entityType ||
                  !same(head.value, record.value)
                );
              });
              if (pending.length) await this.queueEdit(scopeId, pending);
            }, scopeId),
          'local',
        );
        await this.syncScope(scopeId);
        if (journal.interruptedOutbox)
          throw new Error(
            'Setup was recovered on another device. Choose which data to use.',
          );
        journal.offset += batch.length;
        await this.save();
      }
      const data = {
        action: 'finish-migration',
        serverId: this.serverId,
        scopeId,
        deviceId: this.state.device.id,
        count: journal.records.length,
      };
      await this.request('/scopes/' + scopeId + '/migration/finish', {
        deviceId: data.deviceId,
        count: data.count,
        signature: await sign(this.secrets.signingPrivateKey, data),
      });
      await this.syncScope(scopeId);
      if (journal.interruptedOutbox)
        throw new Error(
          'Setup was recovered on another device. Choose which data to use.',
        );
      await this.request('/scopes/' + scopeId + '/checkpoint', {});
      this.state.migrations[scopeId] = { ...journal, complete: true, records: [] };
      try {
        await this.save();
      } catch (error) {
        this.state.migrations[scopeId] = journal;
        throw error;
      }
      return scopeId;
    }, 'migration');
  }
  async invite(
    scopeId: string,
    identifier: string,
    role: 'editor' | 'viewer',
  ): Promise<void> {
    const scope = this.state.scopes[scopeId];
    const { recipient } = await this.request<{ recipient: Recipient | null }>(
      '/recipients',
      { identifier },
    );
    if (recipient) await this.pin(recipient);
    const id = crypto.randomUUID();
    const membership = recipient
      ? await this.membership(scopeId, recipient, role, scope.key, scope.info.epoch, id)
      : null;
    const data = { id, identifier: identifier.trim().toLowerCase(), role, membership };
    await this.request(`/scopes/${scopeId}/invites`, {
      ...data,
      signature: await sign(this.secrets.signingPrivateKey, {
        action: 'invite',
        serverId: this.serverId,
        scopeId,
        ...data,
      }),
    });
  }
  private async pin(recipient: Recipient): Promise<void> {
    const key = await fingerprint({
      encryptionPublicKey: recipient.encryptionPublicKey,
      signingPublicKey: recipient.signingPublicKey,
    });
    const id = 'recipient:' + recipient.id;
    if (this.state.pins[id] && this.state.pins[id] !== key)
      throw new Error('Recipient encryption identity changed');
    this.state.pins[id] = key;
    await this.save();
  }
  async invitations(): Promise<Invitation[]> {
    return (await this.request<{ invites: Invitation[] }>('/invites')).invites;
  }
  async accept(invite: Invitation): Promise<void> {
    if (!invite.membership)
      throw new Error('Waiting for an unlocked owner device to prepare access');
    const a = invite.membership.authorization;
    if (
      a.serverId !== this.serverId ||
      a.accountId !== this.accountId ||
      a.scopeId !== invite.scopeId ||
      a.inviteId !== invite.id ||
      !same(a.encryptionPublicKey, this.account.bundle!.encryptionPublicKey) ||
      !(await verify(invite.ownerKey, a, invite.membership.signature))
    )
      throw new Error('Invitation authentication failed');
    const pinned = this.state.pins[a.ownerId];
    const key = await fingerprint(invite.ownerKey);
    if (pinned && pinned !== key) throw new Error('Project owner identity changed');
    this.state.pins[a.ownerId] = key;
    await this.save();
    const data = {
      action: 'accept',
      serverId: this.serverId,
      inviteId: invite.id,
      membership: invite.membership,
    };
    await this.request(`/invites/${invite.id}/accept`, {
      signature: await sign(this.secrets.signingPrivateKey, data),
    });
    await this.refreshScopes();
    await this.syncScope(invite.scopeId);
  }
  private async provision(scopeId: string): Promise<void> {
    const scope = this.state.scopes[scopeId];
    if (scope.info.state !== 'active') return;
    const { pending } = await this.request<{
      pending: {
        id: string;
        request: {
          id: string;
          identifier: string;
          role: 'editor' | 'viewer';
          membership: Membership | null;
          signature: string;
        };
        recipient: Recipient;
      }[];
    }>(`/scopes/${scopeId}/provisioning`);
    for (const item of pending) {
      if (
        !(await verify(
          scope.info.ownerKey,
          {
            action: 'invite',
            serverId: this.serverId,
            scopeId,
            ...unsigned(item.request),
          },
          item.request.signature,
        ))
      )
        throw new Error('Pending invitation authorization failed');
      if (
        item.request.membership &&
        item.request.membership.authorization.accountId !== item.recipient.id
      )
        throw new Error('Invitation recipient identity changed');
      await this.pin(item.recipient);
      await this.request(
        `/scopes/${scopeId}/provision`,
        await this.membership(
          scopeId,
          item.recipient,
          item.request.role,
          scope.key,
          scope.info.epoch,
          item.id,
        ),
      );
    }
  }
  async removeMember(scopeId: string, removeId: string): Promise<void> {
    await this.syncScope(scopeId);
    return this.exclusive(async () => {
      const scope = this.state.scopes[scopeId];
      if (scope.info.ownerId !== this.accountId || removeId === this.accountId)
        throw new Error('Only the owner can remove another member');
      const key = randomKey();
      const members = await Promise.all(
        scope.info.members
          .filter((m) => m.authorization.accountId !== removeId)
          .map((m) =>
            this.membership(
              scopeId,
              {
                id: m.authorization.accountId,
                username: null,
                encryptionPublicKey: m.authorization.encryptionPublicKey,
                signingPublicKey: m.authorization.signingPublicKey,
              },
              m.authorization.role,
              key,
              scope.info.epoch + 1,
            ),
          ),
      );
      const data = {
        id: crypto.randomUUID(),
        removeId,
        controlVersion: scope.info.controlVersion,
        members,
      };
      scope.info = await this.request<ScopeInfo>(`/scopes/${scopeId}/rotation/start`, {
        ...data,
        signature: await sign(this.secrets.signingPrivateKey, {
          action: 'rotate',
          serverId: this.serverId,
          scopeId,
          ...data,
        }),
      });
      await this.save();
      await this.resumeRotation(scope);
      await this.sync(scopeId);
    }, scopeId);
  }
  private nextMembers(
    scope: LocalScope,
    key: string,
    nextOwner = scope.info.ownerId,
  ): Promise<Membership[]> {
    return Promise.all(
      scope.info.members.map((m) =>
        this.membership(
          scope.info.id,
          {
            id: m.authorization.accountId,
            username: null,
            encryptionPublicKey: m.authorization.encryptionPublicKey,
            signingPublicKey: m.authorization.signingPublicKey,
          },
          m.authorization.accountId === nextOwner
            ? 'owner'
            : m.authorization.role === 'owner'
              ? 'editor'
              : m.authorization.role,
          key,
          scope.info.epoch + 1,
        ),
      ),
    );
  }
  async offerOwnership(scopeId: string, recipientId: string): Promise<void> {
    await this.syncScope(scopeId);
    const scope = this.state.scopes[scopeId];
    const member = scope.info.members.find(
      (m) => m.authorization.accountId === recipientId,
    );
    if (
      scope.info.ownerId !== this.accountId ||
      !member ||
      recipientId === this.accountId
    )
      throw new Error('Choose another existing member');
    const offerLifetime = 7 * 86400000;
    const offer = {
      action: 'transfer-ownership' as const,
      serverId: this.serverId,
      scopeId,
      id: crypto.randomUUID(),
      previousOwnerId: this.accountId,
      previousOwnerKey: scope.info.ownerKey,
      recipientId,
      recipientSigningKey: member.authorization.signingPublicKey,
      recipientEncryptionKey: member.authorization.encryptionPublicKey,
      epoch: scope.info.epoch,
      controlVersion: scope.info.controlVersion,
      expiresAt: Date.now() + offerLifetime - 1000,
    };
    await this.request(`/scopes/${scopeId}/ownership/offer`, {
      ...offer,
      signature: await sign(this.secrets.signingPrivateKey, offer),
    });
  }
  async ownershipOffers(): Promise<OwnershipOffer[]> {
    return (await this.request<{ offers: OwnershipOffer[] }>('/ownership/offers')).offers;
  }
  async acceptOwnership(offer: OwnershipOffer): Promise<void> {
    await this.syncScope(offer.scopeId);
    return this.exclusive(async () => {
      const scope = this.state.scopes[offer.scopeId];
      if (
        offer.recipientId !== this.accountId ||
        offer.previousOwnerId !== scope.info.ownerId ||
        !same(offer.previousOwnerKey, scope.info.ownerKey) ||
        !same(offer.recipientSigningKey, this.account.bundle!.signingPublicKey) ||
        !same(offer.recipientEncryptionKey, this.account.bundle!.encryptionPublicKey) ||
        offer.serverId !== this.serverId ||
        offer.epoch !== scope.info.epoch ||
        offer.controlVersion !== scope.info.controlVersion ||
        offer.expiresAt <= Date.now() ||
        !(await verify(scope.info.ownerKey, unsigned(offer), offer.signature))
      )
        throw new Error('Ownership offer authentication failed');
      const data = {
        offer,
        members: await this.nextMembers(scope, randomKey(), this.accountId),
      };
      const acceptance: OwnershipAcceptance = {
        ...data,
        signature: await sign(
          this.secrets.signingPrivateKey,
          ownershipAcceptanceData(data),
        ),
      };
      scope.info = await this.request<ScopeInfo>(
        `/scopes/${offer.scopeId}/ownership/accept`,
        acceptance,
      );
      await this.save();
      await this.sync(offer.scopeId);
    }, offer.scopeId);
  }
  async checkpoint(scopeId: string): Promise<number> {
    await this.syncScope(scopeId);
    return (await this.request<{ sequence: number }>(`/scopes/${scopeId}/checkpoint`, {}))
      .sequence;
  }
  async checkpoints(scopeId: string): Promise<number[]> {
    return (
      await this.request<{ checkpoints: { sequence: number }[] }>(
        `/scopes/${scopeId}/checkpoints`,
      )
    ).checkpoints.map((c) => c.sequence);
  }
  async restoreProject(scopeId: string, sequence: number): Promise<void> {
    await this.syncScope(scopeId);
    return this.exclusive(async () => {
      const scope = this.state.scopes[scopeId];
      if (scope.info.ownerId !== this.accountId)
        throw new Error('Only the owner can restore a project');
      const data = {
        id: crypto.randomUUID(),
        sequence,
        controlVersion: scope.info.controlVersion,
        members: await this.nextMembers(scope, randomKey()),
      };
      scope.info = await this.request<ScopeInfo>(`/scopes/${scopeId}/restore/start`, {
        ...data,
        signature: await sign(this.secrets.signingPrivateKey, {
          action: 'restore-project',
          serverId: this.serverId,
          scopeId,
          ...data,
        }),
      });
      await this.save();
      await this.sync(scopeId);
    }, scopeId);
  }
  async deleteProject(scopeId: string): Promise<void> {
    await this.syncScope(scopeId);
    return this.exclusive(async () => {
      const scope = this.state.scopes[scopeId];
      if (scope.info.ownerId !== this.accountId)
        throw new Error('Only the owner can delete a project');
      const controlVersion = scope.info.controlVersion;
      await this.request(`/scopes/${scopeId}/delete`, {
        controlVersion,
        signature: await sign(this.secrets.signingPrivateKey, {
          action: 'delete-project',
          serverId: this.serverId,
          scopeId,
          controlVersion,
        }),
      });
      scope.revoked = true;
      await this.save();
    }, scopeId);
  }
  private async resumeRotation(scope: LocalScope): Promise<void> {
    let rotation = scope.info.rotation;
    if (!rotation) throw new Error('Missing project key update');
    if (rotation.kind === 'member-left' && !rotation.members.length) {
      const data = {
        id: rotation.id,
        controlVersion: scope.info.controlVersion,
        members: await this.nextMembers(scope, randomKey()),
      };
      scope.info = await this.request<ScopeInfo>(
        `/scopes/${scope.info.id}/rotation/provision`,
        {
          ...data,
          signature: await sign(this.secrets.signingPrivateKey, {
            action: 'provision-rotation',
            serverId: this.serverId,
            scopeId: scope.info.id,
            ...data,
          }),
        },
      );
      rotation = scope.info.rotation!;
      await this.save();
    }
    const member = rotation.members.find(
      (m) => m.authorization.accountId === this.accountId,
    )!;
    const key = await receiveKey(
      this.secrets.encryptionPrivateKey,
      member.authorization.grant,
      {
        serverId: this.serverId,
        scopeId: scope.info.id,
        recipientId: this.accountId,
        epoch: scope.info.epoch + 1,
      },
    );
    const info = {
      ...scope.info,
      ...(rotation.transfer
        ? {
            ownerId: rotation.transfer.offer.recipientId,
            ownerKey: rotation.transfer.offer.recipientSigningKey,
            ownershipChain: [...(scope.info.ownershipChain ?? []), rotation.transfer],
          }
        : {}),
      epoch: scope.info.epoch + 1,
      generation: scope.info.generation + 1,
      members: rotation.members,
    };
    await verifyOwnershipChain(this.serverId, info, scope.info);
    for (const m of info.members) await this.verifyMembership(info, m);
    let target = scope.heads;
    if (rotation.kind === 'restore') {
      const source = await this.request<ScopeSnapshot>(
        `/scopes/${scope.info.id}/restore/source`,
      );
      if (
        source.scope.id !== scope.info.id ||
        source.scope.epoch !== scope.info.epoch ||
        source.scope.ownerId !== scope.info.ownerId ||
        source.scope.sequence !== rotation.checkpointSequence
      )
        throw new Error('Restore checkpoint context changed');
      target = await this.openSnapshot(source, scope.key);
    }
    const heads = Object.values(scope.heads).map(
      (head) => target[head.entityId] ?? { ...head, deleted: true, value: null },
    );
    validateSharedHierarchy(
      Object.fromEntries(
        heads
          .filter((h) => !h.deleted && h.entityType === 'shared.task')
          .map((h) => [h.entityId, h.value as SharedTask]),
      ),
    );
    for (let offset = 0; offset < heads.length; offset += 100) {
      const mutation = await this.mutation(
        scope,
        heads.slice(offset, offset + 100),
        key,
        info,
      );
      await this.request(`/scopes/${info.id}/rotation/stage`, mutation);
    }
    const data = {
      action: 'finish-rotation',
      serverId: this.serverId,
      scopeId: info.id,
      id: rotation.id,
    };
    await this.request(`/scopes/${info.id}/rotation/finish`, {
      id: rotation.id,
      signature: await sign(this.secrets.signingPrivateKey, data),
    });
  }
}
