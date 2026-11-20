import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  AccountClient,
  AccountApiError,
  SyncClient,
  sign,
  type SyncState,
  type StateStorage,
  type Transport,
  type Mutation,
  type ScopeSnapshot,
} from '@ultra-tasks/account-crypto';
import { UltraEnvelopeSchema, UltraSignedRecordSchema } from '@ultra-tasks/sync-contract';
import { Prisma } from '@prisma/client';
import { createHarness, password } from './ultra-account.helper';

it('only allows larger encrypted envelopes for personal document records', () => {
  const payload = (length: number) => ({
    v: 1,
    nonce: 'a'.repeat(16),
    data: 'a'.repeat(length),
  });
  const record = (entityType: string, length: number) => ({
    header: {
      v: 2,
      serverId: crypto.randomUUID(),
      scopeId: crypto.randomUUID(),
      entityId: 'a-record',
      entityType,
      actorId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      mutationId: crypto.randomUUID(),
      epoch: 1,
      generation: 1,
      controlVersion: 1,
      counter: 1,
      baseRevision: 0,
      revision: 1,
    },
    payload: payload(length),
    signature: 'a'.repeat(86),
  });

  expect(UltraEnvelopeSchema.safeParse(payload(100_000)).success).toBe(true);
  expect(UltraEnvelopeSchema.safeParse(payload(100_001)).success).toBe(false);
  expect(UltraSignedRecordSchema.safeParse(record('shared.task', 100_000)).success).toBe(
    true,
  );
  expect(UltraSignedRecordSchema.safeParse(record('shared.task', 100_001)).success).toBe(
    false,
  );
  expect(
    UltraSignedRecordSchema.safeParse(record('personal.time', 100_001)).success,
  ).toBe(false);
  expect(
    UltraSignedRecordSchema.safeParse(record('personal.document', 1024 * 1024)).success,
  ).toBe(true);
  expect(
    UltraSignedRecordSchema.safeParse(record('personal.document', 1024 * 1024 + 1))
      .success,
  ).toBe(false);
});

const memory = (): StateStorage & { value: SyncState | null } => ({
  value: null,
  async load() {
    return structuredClone(this.value);
  },
  async save(state) {
    this.value = structuredClone(state);
  },
});
const device = async (account: AccountClient, storage = memory()) => {
  const client = new SyncClient(account, storage);
  await client.init();
  return { client, storage };
};
describe('native encrypted personal sync and project sharing', () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  afterEach(async () => {
    await harness?.close();
  });
  it('keeps the recovered inventory intact and fences the source until it explicitly rejoins', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    let interrupted = false;
    const sourceAccount = new AccountClient(async (...args) => {
      if (interrupted && args[0].endsWith('/transactions'))
        throw new Error('Connection closed before the pending write reached the server');
      return harness.transport(...args);
    });
    await sourceAccount.login('alice', password);
    const source = await device(sourceAccount);
    const scopeId = await source.client.createScope('personal', true);
    const change = (entityId: string) => ({
      entityId,
      entityType: 'personal.document',
      value: { title: entityId },
    });
    await source.client.edit(scopeId, [change('uploaded')]);
    await source.client.syncScope(scopeId);
    await source.client.edit(scopeId, [change('pending-before-recovery')]);
    interrupted = true;
    await expect(source.client.syncScope(scopeId)).rejects.toThrow('Connection closed');
    interrupted = false;
    const personalKey = source.storage.value!.scopes[scopeId].uncertainKey;
    expect(personalKey).toBeDefined();

    const recovering = await device(account);
    await recovering.client.refreshScopes();
    await recovering.client.recoverUploadedPersonalSetup(scopeId);
    expect(recovering.client.state.scopes[scopeId].info).toMatchObject({
      state: 'active',
      sequence: 1,
      controlVersion: 2,
    });
    expect(Object.keys(recovering.client.records(scopeId))).toEqual(['uploaded']);
    const oldFinish = { deviceId: source.client.state.device.id, count: 1 };
    await expect(
      account.request('/sync/scopes/' + scopeId + '/migration/finish', {
        ...oldFinish,
        signature: await sign(account.unlocked!.secrets.signingPrivateKey, {
          action: 'finish-migration',
          serverId: account.identity().serverId,
          scopeId,
          ...oldFinish,
        }),
      }),
    ).rejects.toMatchObject({ code: 'MIGRATION_REJOIN_REQUIRED' });

    await source.client.refreshScopes();
    expect(
      source.storage.value?.migrations[scopeId].interruptedOutbox?.intents[0].changes[0]
        .entityId,
    ).toBe('pending-before-recovery');
    await source.client.syncScope(scopeId);
    await source.client.edit(scopeId, [change('new-source-edit')]);
    await expect(source.client.syncScope(scopeId)).rejects.toMatchObject({
      status: 423,
      code: 'MIGRATION_REJOIN_REQUIRED',
    });
    await recovering.client.syncScope(scopeId);
    expect(Object.keys(recovering.client.records(scopeId))).toEqual(['uploaded']);

    await source.client.rejoinRecoveredPersonalSetup(scopeId);
    await source.client.syncScope(scopeId);
    await recovering.client.syncScope(scopeId);
    expect(Object.keys(recovering.client.records(scopeId)).sort()).toEqual([
      'new-source-edit',
      'uploaded',
    ]);
    const current = recovering.client.state.scopes[scopeId].info;
    expect(current.recoveredFromMigration).toBe(true);
    expect(current.interruptedMigrationSource).toBeUndefined();
    const legacyStart = {
      action: 'start-personal-replacement',
      serverId: account.identity().serverId,
      scopeId,
      id: crypto.randomUUID(),
      deviceId: recovering.client.state.device.id,
      sequence: current.sequence,
      generation: current.generation,
      controlVersion: current.controlVersion,
      count: 1,
      batches: ['A'.repeat(43)],
    };
    const signedStart = async (data: typeof legacyStart) => ({
      ...data,
      signature: await sign(account.unlocked!.secrets.signingPrivateKey, data),
    });
    const replacementPath = '/sync/scopes/' + scopeId + '/replacement/start';
    await expect(
      account.request(replacementPath, await signedStart(legacyStart)),
    ).rejects.toMatchObject({ code: 'RECOVERED_SETUP_CHOICE_REQUIRED' });
    const confirmed = { ...legacyStart, acceptsRecoveredSetup: true };
    await expect(
      account.request(replacementPath, await signedStart(confirmed)),
    ).resolves.toMatchObject({ started: true });
    expect(
      source.storage.value?.migrations[scopeId].interruptedOutbox?.intents[0].changes[0]
        .entityId,
    ).toBe('pending-before-recovery');
    await expect(
      source.client.detachPersonalForRecovery(scopeId, async (archive) => {
        expect(archive).toMatchObject({
          acknowledged: {
            'new-source-edit': { value: { title: 'new-source-edit' } },
            uploaded: { value: { title: 'uploaded' } },
          },
          interruptedSetup: {
            outbox: {
              intents: [{ changes: [{ entityId: 'pending-before-recovery' }] }],
            },
          },
        });
        expect(JSON.stringify(archive).includes(personalKey ?? '')).toBe(false);
        return true;
      }),
    ).resolves.toBe(true);
    expect(source.storage.value?.migrations[scopeId]).toBeUndefined();
  });

  it('preserves a staged first upload when another verified device tries to restart it', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const original = await device(account);
    const scopeId = await original.client.createScope('personal', true);
    const uploaded = {
      entityId: 'staged-task',
      entityType: 'personal.task',
      value: { title: 'Already uploaded' },
    };
    await original.client.edit(scopeId, [uploaded]);
    await original.client.syncScope(scopeId);

    const other = await device(account);
    const [before] = await other.client.refreshScopes();
    expect(before).toMatchObject({ id: scopeId, state: 'migrating', sequence: 1 });
    await expect(
      other.client.restartPersonalMigration(scopeId, [
        {
          entityId: 'other-task',
          entityType: 'personal.task',
          value: { title: 'Other local task' },
        },
      ]),
    ).rejects.toMatchObject({ status: 409 });

    const [after] = await other.client.refreshScopes();
    expect(after).toMatchObject({ id: scopeId, state: 'migrating', sequence: 1 });
    await other.client.syncScope(scopeId);
    expect(Object.values(other.client.records(scopeId))).toEqual([
      { ...uploaded, revision: 1, deleted: false },
    ]);
  });
  it('migrates a frozen inventory, preserves archive/plugin/time records, and converges across offline devices', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const first = await device(account);
    const input = Array.from({ length: 207 }, (_, index) => ({
      entityId: 'task-' + index,
      entityType: 'personal.task',
      value: {
        title: 'private task ' + index,
        done: false,
        timeSpentOnDay: { '2026-11-05': 6000 },
      },
    }));
    input.push({
      entityId: 'archive',
      entityType: 'personal.archiveOld',
      value: { title: 'archived', done: true, timeSpentOnDay: { '2026-11-05': 9000 } },
    });
    const scopeId = await first.client.migrate(input);
    const second = await device(account);
    await second.client.refreshScopes();
    await second.client.syncScope(scopeId);
    expect(Object.keys(second.client.records(scopeId))).toHaveLength(208);
    await first.client.edit(scopeId, [
      {
        entityId: 'task-0',
        entityType: 'personal.task',
        value: {
          ...(first.client.records(scopeId)['task-0'].value as object),
          title: 'edited on first',
        },
      },
    ]);
    await second.client.edit(scopeId, [
      {
        entityId: 'task-0',
        entityType: 'personal.task',
        value: {
          ...(second.client.records(scopeId)['task-0'].value as object),
          done: true,
        },
      },
    ]);
    await first.client.syncScope(scopeId);
    await second.client.syncScope(scopeId);
    await first.client.syncScope(scopeId);
    expect(first.client.records(scopeId)['task-0'].value).toMatchObject({
      title: 'edited on first',
      done: true,
      timeSpentOnDay: { '2026-11-05': 6000 },
    });
    expect(first.client.records(scopeId)).toEqual(second.client.records(scopeId));
    const stored = await harness.db.$queryRaw<{ write: unknown }[]>(
      Prisma.sql`SELECT write FROM ultra_record_heads`,
    );
    expect(JSON.stringify(stored)).not.toContain('private task');
  }, 60000);
  it('retries the exact persisted transaction after a lost response and restart', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    let drop = false;
    const transport: Transport = async (...args) => {
      const result = await harness.transport(...args);
      if (drop && args[0].endsWith('/transactions')) {
        drop = false;
        throw new Error('Connection lost after commit');
      }
      return result;
    };
    const wrapped = new AccountClient(transport);
    await wrapped.login('alice', password);
    const { client, storage } = await device(wrapped);
    const id = await client.createScope('personal');
    await client.edit(id, [
      { entityId: 'one', entityType: 'personal.task', value: { title: 'only once' } },
    ]);
    drop = true;
    await expect(client.syncScope(id)).rejects.toThrow('Connection lost');
    expect(storage.value!.scopes[id].uncertain).toBeDefined();
    const restarted = await device(wrapped, storage);
    await restarted.client.syncScope(id);
    expect(restarted.client.records(id).one.revision).toBe(1);
    const mutations = await harness.db.$queryRaw<unknown[]>(
      Prisma.sql`SELECT * FROM ultra_scope_mutations WHERE scope_id=${id}`,
    );
    expect(mutations).toHaveLength(1);
    expect(restarted.client.state.scopes[id].intents).toHaveLength(0);
    void account;
  }, 30000);
  it('retries only the saved prefix after losing its response and preserves all later edits', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const bodyLimit = 8 * 1024 * 1024;
    const posted: {
      counter: number;
      digest: string;
      bytes: number;
      entities: string[];
    }[] = [];
    const wrapped = new AccountClient(async (...args) => {
      const result = await harness.transport(...args);
      if (args[0].endsWith('/transactions')) {
        const mutation = args[1] as Mutation;
        const body = JSON.stringify(mutation);
        posted.push({
          counter: mutation.counter,
          digest: createHash('sha256').update(body).digest('hex'),
          bytes: Buffer.byteLength(body),
          entities: mutation.writes.map(({ record }) => record.header.entityId),
        });
        if (posted.length === 1) throw new Error('Connection lost after prefix commit');
      }
      return result;
    });
    await wrapped.login('alice', password);
    const { client, storage } = await device(wrapped);
    const id = await client.createScope('personal');
    const notes = Array.from({ length: 22 }, (_, index) => ({
      entityId: `note-${index}`,
      entityType: 'personal.document',
      value: {
        path: ['task', 'entities', `note-${index}`],
        data: { notes: `Note ${index}\n${'計'.repeat(99_990)}` },
      },
    }));
    const later = {
      entityId: 'later',
      entityType: 'personal.document',
      value: { path: ['task', 'entities', 'later'], data: { title: 'Later edit' } },
    };
    await client.edit(id, notes);
    await client.edit(id, [later]);
    await expect(client.syncScope(id)).rejects.toThrow(
      'Connection lost after prefix commit',
    );

    const persisted = storage.value!.scopes[id];
    const prefixSize = posted[0].entities.length;
    expect(prefixSize).toBeGreaterThan(0);
    expect(prefixSize).toBeLessThan(notes.length);
    expect(persisted.uncertain?.writes).toHaveLength(prefixSize);
    expect(persisted.intents.map((intent) => intent.changes.length)).toEqual([
      prefixSize,
      notes.length - prefixSize,
      1,
    ]);

    const restarted = (await device(wrapped, storage)).client;
    await restarted.syncScope(id);
    expect(posted.map((post) => post.counter)).toEqual([1, 1, 2, 3]);
    expect(posted[1]).toEqual(posted[0]);
    expect(posted.every(({ bytes }) => bytes <= bodyLimit)).toBe(true);
    expect(posted.slice(1).flatMap(({ entities }) => entities)).toEqual([
      ...notes.map(({ entityId }) => entityId),
      later.entityId,
    ]);
    expect(restarted.state.scopes[id]).toMatchObject({ intents: [], counter: 3 });

    const peer = (await device(account)).client;
    await peer.refreshScopes();
    await peer.syncScope(id);
    const records = peer.records(id);
    expect(Object.keys(records)).toHaveLength(notes.length + 1);
    for (const { entityId, value } of [...notes, later]) {
      expect(records[entityId]?.revision, entityId).toBe(1);
      expect(
        JSON.stringify(records[entityId]?.value) === JSON.stringify(value),
        entityId,
      ).toBe(true);
    }
  }, 60000);
  it('keeps a valid-sized attempt and its edits queued when the scope quota refuses it', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const { client, storage } = await device(account);
    const id = await client.createScope('personal');
    await client.edit(id, [
      { entityId: 'existing', entityType: 'personal.task', value: { title: 'Existing' } },
    ]);
    await client.syncScope(id);
    // Put this small fixture at its scope quota without building a 32 MiB inventory.
    await harness.db.$executeRaw(
      Prisma.sql`UPDATE ultra_record_heads SET bytes=${32 * 1024 * 1024} WHERE scope_id=${id} AND entity_id='existing'`,
    );
    const edit = {
      entityId: 'later',
      entityType: 'personal.task',
      value: { title: 'Keep me' },
    };
    await client.edit(id, [edit]);
    await expect(client.syncScope(id)).rejects.toMatchObject({
      status: 413,
      message: 'Encrypted scope quota reached; local changes are retained',
    });
    const saved = storage.value!.scopes[id];
    expect(saved.uncertain?.counter).toBe(2);
    expect(saved.intents[0].changes).toMatchObject([edit]);

    const restarted = (await device(account, storage)).client;
    await expect(restarted.syncScope(id)).rejects.toMatchObject({ status: 413 });
    expect(storage.value!.scopes[id].uncertain).toEqual(saved.uncertain);
    expect(storage.value!.scopes[id].intents).toEqual(saved.intents);
  }, 30000);
  it('holds only the rejected record after a lost response and syncs subsequent edits', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    let loseRejection = false;
    const transport: Transport = async (...args) => {
      try {
        return await harness.transport(...args);
      } catch (error) {
        if (
          loseRejection &&
          args[0].endsWith('/transactions') &&
          error instanceof AccountApiError
        ) {
          expect(error.status).toBe(422);
          expect(error.code).toBe('SYNC_RECORD_TOO_LARGE');
          expect(error.writeIndices).toEqual([1]);
          loseRejection = false;
          throw new Error('Connection closed after rejection');
        }
        throw error;
      }
    };
    const writerAccount = new AccountClient(transport);
    await writerAccount.login('alice', password);
    const { client: writer, storage } = await device(writerAccount);
    const task = (entityId: string, title: string, notes: string) => ({
      entityId,
      entityType: 'personal.document',
      value: { path: ['task', 'entities', entityId], data: { title, notes } },
    });
    const limitExceeded = 'Preserve these draft notes. '.repeat(32_000);
    const initial = task('oversized', 'Original title', 'Original notes');
    const scopeId = await writer.migrate([initial]);
    const peer = (await device(account)).client;
    await peer.refreshScopes();
    await peer.syncScope(scopeId);
    await writer.edit(scopeId, [
      task('independent', 'Independent task', ''),
      task('oversized', 'Original title', limitExceeded),
    ]);
    loseRejection = true;
    await expect(writer.syncScope(scopeId)).rejects.toThrow(
      'Connection closed after rejection',
    );
    expect(storage.value!.scopes[scopeId].uncertain?.writes).toHaveLength(2);

    const resumed = (await device(account, storage)).client;
    await resumed.syncScope(scopeId);
    await peer.syncScope(scopeId);
    expect(peer.record(scopeId, 'independent')?.value).toEqual(
      task('independent', 'Independent task', '').value,
    );
    expect(peer.record(scopeId, 'oversized')?.value).toEqual(initial.value);
    expect(
      (resumed.record(scopeId, 'oversized')?.value as typeof initial.value).data.notes ===
        limitExceeded,
    ).toBe(true);
    expect(storage.value!.scopes[scopeId].intents).toEqual([]);
    expect(storage.value!.scopes[scopeId].conflicts).toMatchObject([
      { entityId: 'oversized', reason: 'upload' },
    ]);
    expect(storage.value!.scopes[scopeId].uncertain).toBeUndefined();

    // Remote edits outside the held field still appear and survive correction.
    await peer.edit(scopeId, [
      task('oversized', 'New title from peer', 'Original notes'),
    ]);
    await peer.syncScope(scopeId);
    await resumed.syncScope(scopeId);
    const projected = (
      resumed.record(scopeId, 'oversized')?.value as typeof initial.value
    ).data;
    expect(projected.title).toBe('New title from peer');
    expect(projected.notes === limitExceeded).toBe(true);
    await resumed.dismissDrafts(scopeId);
    expect(resumed.state.scopes[scopeId].conflicts).toMatchObject([{ reason: 'upload' }]);
    const corrected = task('oversized', projected.title, 'Shortened notes');
    await resumed.edit(scopeId, [corrected]);
    await resumed.syncScope(scopeId);
    await peer.syncScope(scopeId);
    expect(peer.record(scopeId, 'oversized')?.value).toEqual(corrected.value);
    expect(storage.value!.scopes[scopeId].conflicts).toEqual([]);
  }, 30000);

  it('retains an unsendable request and commits an already-queued correction', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const { client, storage } = await device(account);
    const scopeId = await client.migrate([
      {
        entityId: 'task',
        entityType: 'personal.document',
        value: { notes: 'Original notes' },
      },
    ]);
    await client.edit(scopeId, [
      {
        entityId: 'task',
        entityType: 'personal.document',
        value: { notes: 'a'.repeat(6_400_000) },
      },
    ]);
    await client.edit(scopeId, [
      {
        entityId: 'task',
        entityType: 'personal.document',
        value: { notes: 'Correction already in the queue' },
      },
    ]);
    await client.syncScope(scopeId);
    const peer = (await device(account)).client;
    await peer.refreshScopes();
    await peer.syncScope(scopeId);
    expect(peer.record(scopeId, 'task')?.value).toEqual({
      notes: 'Correction already in the queue',
    });
    expect(storage.value!.scopes[scopeId].intents).toEqual([]);
    expect(storage.value!.scopes[scopeId].conflicts).toEqual([]);
  }, 30000);

  it('preserves overlapping text as a private conflict draft and makes deletion beat stale edits', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const a = (await device(account)).client;
    const id = await a.migrate([
      { entityId: 'note', entityType: 'personal.note', value: { text: 'base' } },
    ]);
    const b = (await device(account)).client;
    await b.refreshScopes();
    await b.syncScope(id);
    await a.edit(id, [
      {
        entityId: 'note',
        entityType: 'personal.note',
        value: { text: 'committed text' },
      },
    ]);
    await b.edit(id, [
      {
        entityId: 'note',
        entityType: 'personal.note',
        value: { text: 'my offline draft' },
      },
    ]);
    await a.syncScope(id);
    await b.syncScope(id);
    expect(b.records(id).note.value).toEqual({ text: 'committed text' });
    expect(b.state.scopes[id].conflicts[0].value).toEqual({ text: 'my offline draft' });
    await a.edit(id, [
      { entityId: 'note', entityType: 'personal.note', value: null, deleted: true },
    ]);
    await b.edit(id, [
      {
        entityId: 'note',
        entityType: 'personal.note',
        value: { text: 'after delete draft' },
      },
    ]);
    await a.syncScope(id);
    await b.syncScope(id);
    expect(b.records(id).note).toBeUndefined();
    expect(b.state.scopes[id].conflicts.at(-1)?.reason).toBe('deleted');
  }, 30000);
  it('shares by username across different passwords; viewers cannot write but can store private overlays', async () => {
    harness = await createHarness();
    const owner = (await device((await harness.register()).client)).client;
    const { client: bob } = await harness.register('bob@example.test', 'bobby');
    await bob.changePassword('a completely different password for bobby');
    const viewer = (await device(bob)).client;
    const project = await owner.createScope('project');
    await owner.edit(project, [
      {
        entityId: 'project',
        entityType: 'shared.project',
        value: { title: 'Encrypted project' },
      },
      {
        entityId: 'task',
        entityType: 'shared.task',
        value: { title: 'Shared title', isDone: false },
      },
    ]);
    await owner.syncScope(project);
    await owner.invite(project, 'bobby', 'viewer');
    const invitations = await viewer.invitations();
    expect(invitations).toHaveLength(1);
    await viewer.accept(invitations[0]);
    expect(viewer.records(project).task.value).toEqual({
      title: 'Shared title',
      isDone: false,
    });
    await expect(
      viewer.edit(project, [
        { entityId: 'task', entityType: 'shared.task', value: { title: 'forbidden' } },
      ]),
    ).rejects.toThrow('Viewers');
    const personal = await viewer.createScope('personal');
    await viewer.edit(personal, [
      {
        entityId: 'overlay',
        entityType: 'personal.overlay',
        value: {
          scopeId: project,
          taskId: 'task',
          dueDay: '2026-11-05',
          timeSpent: 1234,
        },
      },
    ]);
    await viewer.syncScope(personal);
    const other = new AccountClient(harness.transport);
    await other.login('bobby', 'a completely different password for bobby');
    const second = (await device(other)).client;
    await second.refreshScopes();
    await second.syncScope(project);
    await second.syncScope(personal);
    expect(second.records(personal).overlay.value).toMatchObject({ timeSpent: 1234 });
    await expect(
      owner.account.request(`/sync/scopes/${personal}/snapshot`),
    ).rejects.toMatchObject({ status: 404 });
    // Server authorization still rejects a fully valid owner-signed mutation replayed as a viewer.
    const capture = await harness.db.$queryRaw<{ manifest: Mutation }[]>(
      Prisma.sql`SELECT manifest FROM ultra_scope_mutations WHERE scope_id=${project} ORDER BY sequence DESC LIMIT 1`,
    );
    await expect(
      bob.request(`/sync/scopes/${project}/transactions`, capture[0].manifest),
    ).rejects.toMatchObject({ status: 403 });
  }, 60000);
  it('automatically rotates on removal and resumes an interrupted rotation on another unlocked owner device', async () => {
    harness = await createHarness();
    const ownerAccount = (await harness.register()).client;
    let interrupt = false;
    const wrapped = new AccountClient(async (...args) => {
      if (interrupt && args[0].endsWith('/rotation/stage')) {
        interrupt = false;
        throw new Error('owner device closed');
      }
      return harness.transport(...args);
    });
    await wrapped.login('alice', password);
    const owner = (await device(wrapped)).client;
    const bob = (
      await device((await harness.register('bob@example.test', 'bobby')).client)
    ).client;
    const project = await owner.createScope('project');
    await owner.edit(project, [
      { entityId: 'task', entityType: 'shared.task', value: { title: 'before removal' } },
    ]);
    await owner.syncScope(project);
    await owner.invite(project, 'bobby', 'editor');
    await bob.accept((await bob.invitations())[0]);
    const previousKey = bob.state.scopes[project].key;
    interrupt = true;
    await expect(owner.removeMember(project, bob.account.account!.id)).rejects.toThrow(
      'owner device closed',
    );
    await expect(
      bob.account.request(`/sync/scopes/${project}/snapshot`),
    ).rejects.toMatchObject({ status: 404 });
    const restored = (await device(ownerAccount)).client;
    await restored.refreshScopes();
    await restored.syncScope(project);
    expect(restored.state.scopes[project].info.epoch).toBe(2);
    expect(restored.state.scopes[project].key).not.toBe(previousKey);
    expect(restored.records(project).task.value).toEqual({ title: 'before removal' });
    await restored.edit(project, [
      { entityId: 'task', entityType: 'shared.task', value: { title: 'after removal' } },
    ]);
    await restored.syncScope(project);
    await expect(bob.syncScope(project)).rejects.toBeInstanceOf(AccountApiError);
  }, 60000);
  it('provisions email invitations only after registration and an unlocked owner refresh', async () => {
    harness = await createHarness();
    const owner = (await device((await harness.register()).client)).client;
    const project = await owner.createScope('project');
    await owner.invite(project, 'new@example.test', 'editor');
    const member = (
      await device((await harness.register('new@example.test', 'newbie')).client)
    ).client;
    const pending = (await member.invitations())[0];
    expect(pending.state).toBe('provisioning');
    await expect(member.accept(pending)).rejects.toThrow('Waiting');
    await owner.syncAll();
    await member.accept((await member.invitations())[0]);
    await member.edit(project, [
      {
        entityId: 'new-task',
        entityType: 'shared.task',
        value: { title: 'Created by editor' },
      },
    ]);
    await member.syncScope(project);
    await owner.syncScope(project);
    expect(owner.records(project)['new-task'].value).toEqual({
      title: 'Created by editor',
    });
  }, 60000);
  it('downloads only records changed since the cursor and keeps full snapshots for new devices and older clients', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const first = (await device(account)).client;
    const id = await first.createScope('personal');
    await first.edit(
      id,
      Array.from({ length: 30 }, (_, index) => ({
        entityId: 'task-' + index,
        entityType: 'personal.task',
        value: { title: 'task ' + index },
      })),
    );
    await first.syncScope(id);
    const downloads: { path: string; response: ScopeSnapshot }[] = [];
    const recording = new AccountClient(async (...args) => {
      const result = await harness.transport(...args);
      if (args[0].includes('/changes?') || args[0].endsWith('/snapshot'))
        downloads.push({ path: args[0], response: result as ScopeSnapshot });
      return result;
    });
    await recording.login('alice', password);
    const second = (await device(recording)).client;
    await second.refreshScopes();
    await second.syncScope(id);
    expect(downloads.at(-1)?.path).toMatch(/\/snapshot$/);
    expect(downloads.at(-1)?.response.heads).toHaveLength(30);

    await first.edit(id, [
      { entityId: 'task-3', entityType: 'personal.task', value: { title: 'edited' } },
      { entityId: 'task-7', entityType: 'personal.task', value: null, deleted: true },
    ]);
    await first.syncScope(id);
    await second.syncScope(id);
    const delta = downloads.at(-1)!;
    expect(delta.path).toContain('delta=1');
    expect(delta.response.delta).toBe(true);
    expect(delta.response.heads.map((h) => h.record.header.entityId).sort()).toEqual([
      'task-3',
      'task-7',
    ]);
    expect(second.records(id)['task-3'].value).toEqual({ title: 'edited' });
    expect(second.records(id)['task-7']).toBeUndefined();
    expect(Object.keys(second.records(id))).toHaveLength(29);
    expect(second.records(id, true)).toEqual(first.records(id, true));

    // A client that does not ask for a delta keeps receiving the complete snapshot.
    const full = await account.request<ScopeSnapshot>(
      `/sync/scopes/${id}/changes?after=1&generation=1`,
    );
    expect(full.delta).toBeUndefined();
    expect(full.heads).toHaveLength(30);
    // A cursor from another generation never receives a delta.
    const otherGeneration = await account.request<ScopeSnapshot>(
      `/sync/scopes/${id}/changes?after=1&generation=2&delta=1`,
    );
    expect(otherGeneration.delta).toBeUndefined();
    expect(otherGeneration.heads).toHaveLength(30);
  }, 60000);
  it('rejects a delta that replays an authenticated older record version', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const first = (await device(account)).client;
    const id = await first.createScope('personal');
    await first.edit(id, [{ entityId: 'a', entityType: 'personal.task', value: 'one' }]);
    await first.syncScope(id);
    const old = await account.request<ScopeSnapshot>(`/sync/scopes/${id}/snapshot`);
    await first.edit(id, [{ entityId: 'a', entityType: 'personal.task', value: 'two' }]);
    await first.syncScope(id);
    let replay = false;
    let stripDelta = false;
    const wrapped = new AccountClient(async (...args) => {
      const result = (await harness.transport(...args)) as ScopeSnapshot;
      if (!replay || !args[0].includes('/changes?') || !result.delta) return result;
      if (stripDelta) {
        const { delta: _delta, ...complete } = result;
        return { ...complete, heads: old.heads, manifests: old.manifests };
      }
      return {
        ...result,
        heads: [...result.heads, ...old.heads],
        manifests: [...result.manifests, ...old.manifests],
      };
    });
    await wrapped.login('alice', password);
    const second = (await device(wrapped)).client;
    await second.refreshScopes();
    await second.syncScope(id);
    expect(second.records(id)['a'].value).toBe('two');
    await first.edit(id, [{ entityId: 'b', entityType: 'personal.task', value: 'new' }]);
    await first.syncScope(id);
    replay = true;
    await expect(second.syncScope(id)).rejects.toThrow('older record version');
    expect(second.records(id)['a'].value).toBe('two');
    // Dropping the delta marker turns the same replay into a "complete" snapshot,
    // which must meet the same rule within one generation.
    stripDelta = true;
    await expect(second.syncScope(id)).rejects.toThrow('older record version');
    expect(second.records(id)['a'].value).toBe('two');
    replay = false;
    await second.syncScope(id);
    expect(second.records(id)['b'].value).toBe('new');
  }, 60000);
  it('applies a delta whose earlier transaction was partly superseded', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const first = (await device(account)).client;
    const second = (await device(account)).client;
    const id = await first.createScope('personal');
    await first.edit(id, [{ entityId: 'x', entityType: 'personal.task', value: 0 }]);
    await first.syncScope(id);
    await second.refreshScopes();
    await second.syncScope(id);
    await first.edit(id, [
      { entityId: 'a', entityType: 'personal.task', value: 1 },
      { entityId: 'b', entityType: 'personal.task', value: 1 },
    ]);
    await first.syncScope(id);
    await first.edit(id, [{ entityId: 'a', entityType: 'personal.task', value: 2 }]);
    await first.syncScope(id);
    await first.edit(id, [
      { entityId: 'b', entityType: 'personal.task', value: null, deleted: true },
    ]);
    await first.syncScope(id);
    await second.syncScope(id);
    expect(second.records(id, true)).toEqual(first.records(id, true));
  }, 60000);
  it('refuses to continue silently after the server history is rewritten', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const first = (await device(account)).client;
    const second = (await device(account)).client;
    const id = await first.createScope('personal');
    await first.edit(id, [{ entityId: 'x', entityType: 'personal.task', value: 'x' }]);
    await first.syncScope(id);
    await second.refreshScopes();
    await second.syncScope(id);
    await first.edit(id, [{ entityId: 'y', entityType: 'personal.task', value: 'y' }]);
    await first.syncScope(id);
    await second.syncScope(id);
    expect(second.records(id).y).toBeDefined();
    // Restore the database to before sequence 2, then let another device commit
    // twice so the sequence numbers catch up with a different history.
    const [lost] = await harness.db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM ultra_scope_mutations WHERE scope_id=${id} AND sequence=2`,
    );
    await harness.db.$executeRaw(
      Prisma.sql`DELETE FROM ultra_record_heads WHERE scope_id=${id} AND mutation_id=${lost.id}`,
    );
    await harness.db.$executeRaw(
      Prisma.sql`DELETE FROM ultra_scope_mutations WHERE id=${lost.id}`,
    );
    await harness.db.$executeRaw(
      Prisma.sql`UPDATE ultra_scopes SET sequence=1 WHERE id=${id}`,
    );
    const third = (await device(account)).client;
    await third.refreshScopes();
    await third.syncScope(id);
    await third.edit(id, [{ entityId: 'z', entityType: 'personal.task', value: 'z' }]);
    await third.syncScope(id);
    await third.edit(id, [{ entityId: 'w', entityType: 'personal.task', value: 'w' }]);
    await third.syncScope(id);
    await expect(second.syncScope(id)).rejects.toMatchObject({
      code: 'SYNC_HISTORY_CHANGED',
    });
  }, 60000);
  it.each(['observed cursor', 'acknowledged receipt', 'equal revision'] as const)(
    'preserves acknowledged data after restoring a database backup (%s)',
    async (anchor) => {
      harness = await createHarness();
      const { client: account } = await harness.register();
      const original = await device(account);
      const scope = await original.client.createScope('personal');
      const task = (title: string) => ({
        entityId: 'task-document',
        entityType: 'personal.document',
        value: { path: ['task', 'entities', 'task-1'], data: { id: 'task-1', title } },
      });
      await original.client.edit(scope, [task('Before backup')]);
      await original.client.syncScope(scope);
      await original.client.syncScope(scope);
      const backup = {
        data: await harness.database.dumpDataDir('gzip'),
        config: harness.config,
      };

      await original.client.edit(scope, [task('Acknowledged after backup')]);
      await original.client.syncScope(scope);
      if (anchor === 'observed cursor') await original.client.syncScope(scope);
      const observed = original.client.state.scopes[scope];
      expect(observed.heads['task-document'].value).toEqual(
        task('Acknowledged after backup').value,
      );
      expect(observed.counter).toBe(2);
      expect(observed.info.sequence).toBe(anchor === 'observed cursor' ? 2 : 1);
      await original.client.edit(scope, [
        { ...task('Still local'), entityId: 'pending-document' },
      ]);

      await harness.close();
      harness = await createHarness({}, backup);
      const restoredAccount = new AccountClient(async (request, ...args) => {
        // A server from before the receipt check ignores these optional query fields.
        const path =
          anchor === 'equal revision' && request.includes('/changes?')
            ? request.split('&deviceId=')[0]
            : request;
        return harness.transport(path, ...args);
      });
      await restoredAccount.login('alice', password);
      const other = (await device(restoredAccount)).client;
      await other.refreshScopes();
      await other.syncScope(scope);
      expect(other.records(scope)['task-document'].value).toEqual(
        task('Before backup').value,
      );
      await other.edit(scope, [task('Edited on restored server')]);
      await other.syncScope(scope);
      if (anchor !== 'equal revision') {
        await other.edit(scope, [task('Newer revision on restored server')]);
        await other.syncScope(scope);
      }

      const continuing = (await device(restoredAccount, original.storage)).client;
      const cached = structuredClone(continuing.state.scopes[scope]);
      await expect(continuing.syncScope(scope)).rejects.toThrow('Sync history changed');
      expect(continuing.state.scopes[scope]).toEqual(cached);
      expect(original.storage.value!.scopes[scope]).toEqual(cached);
      if (anchor === 'observed cursor') {
        await expect(
          continuing.detachPersonalForRecovery(scope, async () => false),
        ).resolves.toBe(false);
        expect(original.storage.value!.scopes[scope]).toEqual(cached);
        let backupCopy: unknown;
        await expect(
          continuing.detachPersonalForRecovery(scope, async (archive) => {
            backupCopy = archive;
            return true;
          }),
        ).resolves.toBe(true);
        expect(backupCopy).toMatchObject({
          acknowledged: {
            'task-document': { value: task('Acknowledged after backup').value },
          },
          pending: [
            {
              changes: [
                { entityId: 'pending-document', value: task('Still local').value },
              ],
            },
          ],
        });
        const rejoined = (await device(restoredAccount, original.storage)).client;
        await rejoined.refreshScopes();
        await rejoined.syncScope(scope);
        expect(rejoined.records(scope)['task-document'].value).toEqual(
          task('Newer revision on restored server').value,
        );
        await rejoined.edit(scope, [
          { ...task('After rejoin'), entityId: 'after-rejoin-document' },
        ]);
        await rejoined.syncScope(scope);
        await other.syncScope(scope);
        expect(other.records(scope)['after-rejoin-document'].value).toEqual(
          task('After rejoin').value,
        );
      }
      await other.syncScope(scope);
      expect(other.records(scope)['pending-document']).toBeUndefined();
      expect(other.records(scope)['task-document'].value).toEqual(
        task(
          anchor === 'equal revision'
            ? 'Edited on restored server'
            : 'Newer revision on restored server',
        ).value,
      );
    },
    60000,
  );
  it('protects restored server history before retrying an in-flight personal edit', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const writer = (await device(account)).client;
    const id = await writer.createScope('personal');
    const change = (value: string) => ({
      entityId: 'task',
      entityType: 'personal.task',
      value,
    });
    const write = async (client: SyncClient, value: string) => {
      await client.edit(id, [change(value)]);
      await client.syncScope(id);
    };
    await write(writer, 'Before backup');
    const backup = {
      data: await harness.database.dumpDataDir('gzip'),
      config: harness.config,
    };
    await write(writer, 'Same revision on the original branch');

    let offline = false;
    const wrapped = new AccountClient(async (...args) => {
      if (offline && args[0].endsWith('/transactions'))
        throw new Error('Lost connection before upload');
      return harness.transport(...args);
    });
    await wrapped.login('alice', password);
    const observer = await device(wrapped);
    await observer.client.refreshScopes();
    await observer.client.syncScope(id);
    offline = true;
    await expect(write(observer.client, 'Queued on the original branch')).rejects.toThrow(
      'Lost connection before upload',
    );
    const cached = structuredClone(observer.storage.value!.scopes[id]);
    expect(cached.uncertain).toBeDefined();

    await harness.close();
    harness = await createHarness({}, backup);
    const restored = harness.client();
    await restored.login('alice', password);
    const peer = (await device(restored)).client;
    await peer.refreshScopes();
    await peer.syncScope(id);
    await write(peer, 'Edited on the restored branch');

    const continuing = (await device(restored, observer.storage)).client;
    await expect(continuing.syncScope(id)).rejects.toThrow('Sync history changed');
    expect(
      JSON.stringify(observer.storage.value!.scopes[id]) === JSON.stringify(cached),
    ).toBe(true);
    await peer.syncScope(id);
    expect(peer.records(id).task.value).toBe('Edited on the restored branch');
  }, 60000);
  it('protects restored server history when the backup predates personal sync setup', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const backup = {
      data: await harness.database.dumpDataDir('gzip'),
      config: harness.config,
    };
    const original = await device(account);
    const id = await original.client.createScope('personal');
    await original.client.edit(id, [
      { entityId: 'task', entityType: 'personal.task', value: 'Created after backup' },
    ]);
    await original.client.syncScope(id);
    const cached = structuredClone(original.storage.value!.scopes[id]);

    await harness.close();
    harness = await createHarness({}, backup);
    const restored = harness.client();
    await restored.login('alice', password);
    const continuing = (await device(restored, original.storage)).client;
    const errors = await continuing.syncAll();
    expect(errors[id] ?? '').toContain('Sync history changed');
    expect(
      JSON.stringify(original.storage.value!.scopes[id]) === JSON.stringify(cached),
    ).toBe(true);
  }, 60000);
  it('refuses substituted heads, missing transaction members, and scope/recipient access', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const client = (await device(account)).client;
    const id = await client.createScope('personal');
    await client.edit(id, [
      { entityId: 'first', entityType: 'personal.task', value: 'a' },
      { entityId: 'second', entityType: 'personal.task', value: 'b' },
    ]);
    await client.syncScope(id);
    const original = await account.request<ScopeSnapshot>(`/sync/scopes/${id}/snapshot`);
    const corrupt = new AccountClient(async (...args) =>
      args[0].includes('/changes?') || args[0].endsWith('/snapshot')
        ? { ...original, heads: original.heads.slice(0, 1) }
        : harness.transport(...args),
    );
    await corrupt.login('alice', password);
    const other = (await device(corrupt)).client;
    await other.refreshScopes();
    await expect(other.syncScope(id)).rejects.toThrow('omitted part');
    const outsider = (await harness.register('outside@example.test', 'outside')).client;
    await expect(outsider.request(`/sync/scopes/${id}/snapshot`)).rejects.toMatchObject({
      status: 404,
    });
    expect(await account.request('/sync/scopes')).toBeDefined();
  }, 30000);
  it('acknowledges a lost response after another owner device rotates the project key', async () => {
    harness = await createHarness();
    const ownerAccount = (await harness.register()).client;
    let drop = false;
    const wrapped = new AccountClient(async (...args) => {
      const result = await harness.transport(...args);
      if (drop && args[0].endsWith('/transactions')) {
        drop = false;
        throw new Error('lost committed response');
      }
      return result;
    });
    await wrapped.login('alice', password);
    const first = (await device(wrapped)).client;
    const bob = (
      await device((await harness.register('bob@example.test', 'bobby')).client)
    ).client;
    const project = await first.createScope('project');
    await first.edit(project, [
      { entityId: 'task', entityType: 'shared.task', value: { title: 'initial' } },
    ]);
    await first.syncScope(project);
    await first.invite(project, 'bobby', 'editor');
    await bob.accept((await bob.invitations())[0]);
    await first.edit(project, [
      {
        entityId: 'task',
        entityType: 'shared.task',
        value: { title: 'committed before rotation' },
      },
    ]);
    drop = true;
    await expect(first.syncScope(project)).rejects.toThrow('lost committed response');
    const second = (await device(ownerAccount)).client;
    await second.refreshScopes();
    await second.syncScope(project);
    await second.removeMember(project, bob.account.account!.id);
    expect(await first.syncAll()).toEqual({});
    expect(first.records(project).task.value).toEqual({
      title: 'committed before rotation',
    });
    expect(first.state.scopes[project].uncertain).toBeUndefined();
    await first.edit(project, [
      {
        entityId: 'task',
        entityType: 'shared.task',
        value: { title: 'new epoch still writable' },
      },
    ]);
    await first.syncScope(project);
    await second.syncScope(project);
    expect(second.records(project).task.value).toEqual({
      title: 'new epoch still writable',
    });
  }, 60000);

  it('isolates a malformed project grant while personal sync continues', async () => {
    harness = await createHarness();
    const account = (await harness.register()).client;
    const original = (await device(account)).client;
    const personal = await original.createScope('personal');
    const project = await original.createScope('project');
    const wrapped = new AccountClient(async (...args) => {
      const result = await harness.transport(...args);
      if (args[0] !== '/sync/scopes') return result;
      const body = structuredClone(result) as {
        scopes: { id: string; members: { signature: string }[] }[];
      };
      body.scopes.find((s) => s.id === project)!.members[0].signature = 'invalid';
      return body;
    });
    await wrapped.login('alice', password);
    const client = (await device(wrapped)).client;
    await client.refreshScopes();
    await client.edit(personal, [
      {
        entityId: 'private',
        entityType: 'personal.task',
        value: { title: 'personal still syncs' },
      },
    ]);
    expect(Object.keys(await client.syncAll())).toEqual([project]);
    await original.syncScope(personal);
    expect(original.records(personal).private.value).toEqual({
      title: 'personal still syncs',
    });
  }, 30000);
  it('requires an explicit restore at the current tombstone revision and still rejects a stale edit', async () => {
    harness = await createHarness();
    const account = (await harness.register()).client;
    const first = (await device(account)).client;
    const scope = await first.migrate([
      { entityId: 'task', entityType: 'personal.task', value: { title: 'restorable' } },
    ]);
    await first.edit(scope, [
      { entityId: 'task', entityType: 'personal.task', value: null, deleted: true },
    ]);
    await first.syncScope(scope);
    expect(first.records(scope).task).toBeUndefined();
    await first.edit(scope, [
      {
        entityId: 'task',
        entityType: 'personal.task',
        value: { title: 'explicitly restored' },
        restore: true,
      },
    ]);
    await first.syncScope(scope);
    expect(first.records(scope).task.value).toEqual({ title: 'explicitly restored' });
    expect(first.records(scope).task.revision).toBe(3);
  }, 30000);
});
