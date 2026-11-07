import { afterEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  AccountClient,
  SyncClient,
  sign,
  type SyncState,
  type Transport,
  type ScopeSnapshot,
} from '@ultra-tasks/account-crypto';
import { createHarness } from './ultra-account.helper';

const memory = () => ({
  value: null as SyncState | null,
  async load() {
    return structuredClone(this.value);
  },
  async save(state: SyncState) {
    this.value = structuredClone(state);
  },
});
const device = async (account: AccountClient, storage = memory()) => {
  const client = new SyncClient(account, storage);
  await client.init();
  await client.refreshScopes();
  return { client, storage };
};
const task = (title: string, entityId = 'task') => ({
  entityId,
  entityType: 'shared.task',
  value: { title },
});

describe('native ownership, restore, account deletion and offline recovery', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  afterEach(async () => h?.close());
  const shared = async (role: 'editor' | 'viewer' = 'editor') => {
    h = await createHarness();
    const alice = (await device((await h.register()).client)).client;
    const bobAccount = (await h.register('bob@example.test', 'bobby')).client;
    await bobAccount.changePassword('an entirely separate password for Bob');
    const bob = (await device(bobAccount)).client;
    const project = await alice.createScope('project');
    await alice.edit(project, [task('original')]);
    await alice.syncScope(project);
    await alice.invite(project, 'bobby', role);
    await bob.accept((await bob.invitations())[0]);
    return { alice, bob, project, bobAccount };
  };
  it('requires both owners, accepts a viewer, rotates keys and authenticates offline clients through the ownership chain', async () => {
    const { alice, bob, project, bobAccount } = await shared('viewer');
    const offline = (await device(alice.account)).client;
    await offline.syncScope(project);
    await offline.edit(project, [task('offline owner edit')]);
    delete offline.state.scopes[project].info.ownershipChain;
    const before = alice.state.scopes[project].key;
    await alice.offerOwnership(project, bobAccount.account!.id);
    const offer = (await bob.ownershipOffers())[0];
    await expect(
      bob.acceptOwnership({
        ...offer,
        recipientSigningKey: alice.account.bundle!.signingPublicKey,
      }),
    ).rejects.toThrow();
    await bob.acceptOwnership(offer);
    expect(bob.state.scopes[project].info.ownerId).toBe(bobAccount.account!.id);
    expect(bob.state.scopes[project].key).not.toBe(before);
    await offline.syncScope(project);
    await bob.syncScope(project);
    await alice.syncScope(project);
    expect(bob.records(project).task.value).toEqual({ title: 'offline owner edit' });
    expect(
      alice.state.scopes[project].info.members.find(
        (m) => m.authorization.accountId === alice.account.account!.id,
      )?.authorization.role,
    ).toBe('editor');
    await expect(alice.deleteProject(project)).rejects.toThrow('Only the owner');
    // A compromised server cannot simply name a new owner/root without the dual proof.
    const tampered = new AccountClient(async (...args) => {
      const result = await h.transport(...args);
      if (args[0].endsWith('/snapshot')) {
        const snapshot = result as ScopeSnapshot;
        snapshot.scope.ownerId = alice.account.account!.id;
        snapshot.scope.ownerKey = alice.account.bundle!.signingPublicKey;
        snapshot.scope.ownershipChain = [];
      }
      return result;
    });
    tampered.capabilities = bobAccount.capabilities;
    tampered.account = bobAccount.account;
    tampered.bundle = bobAccount.bundle;
    tampered.unlocked = bobAccount.unlocked;
    tampered.adoptTokens(bobAccount.tokens!);
    const cached = memory();
    cached.value = structuredClone(bob.state);
    cached.value.scopes[project].downloaded = false;
    const attacked = new SyncClient(tampered, cached);
    await attacked.init();
    await expect(attacked.syncScope(project)).rejects.toThrow('ownership history');
  }, 60000);
  it('resumes an interrupted ownership rekey on another unlocked recipient device', async () => {
    const { alice, bob, project, bobAccount } = await shared();
    await alice.offerOwnership(project, bobAccount.account!.id);
    const offer = (await bob.ownershipOffers())[0];
    const original = bobAccount.transport;
    let fail = true;
    Object.defineProperty(bobAccount, 'transport', {
      value: (async (...args) => {
        if (fail && args[0].endsWith('/rotation/stage')) {
          fail = false;
          throw new Error('Device suspended');
        }
        return original(...args);
      }) satisfies Transport,
    });
    await expect(bob.acceptOwnership(offer)).rejects.toThrow('Device suspended');
    const another = (await device(bobAccount)).client;
    await another.syncScope(project);
    await alice.syncScope(project);
    expect(another.state.scopes[project].info.state).toBe('active');
    expect(another.state.scopes[project].info.ownerId).toBe(bobAccount.account!.id);
    expect(another.records(project).task.value).toEqual({ title: 'original' });
  }, 60000);
  it('restores shared records in a new generation, keeps tombstones and private history, and preserves stale edits as drafts', async () => {
    const { alice, bob, project } = await shared();
    const personal = await bob.createScope('personal');
    await bob.edit(personal, [
      {
        entityId: 'my-overlay',
        entityType: 'personal.overlay',
        value: {
          scopeId: project,
          taskId: 'task',
          label: 'original',
          personalNotes: 'private',
          timeBuckets: { device: 3000 },
        },
      },
    ]);
    await bob.syncScope(personal);
    const checkpoint = await alice.checkpoint(project);
    await alice.edit(project, [task('newer'), task('created after snapshot', 'new')]);
    await alice.syncScope(project);
    await bob.syncScope(project);
    await bob.edit(project, [task('offline stale edit')]);
    const privateBefore = bob.records(personal);
    await alice.edit(project, [{ ...task('deleted'), deleted: true }]);
    await alice.syncScope(project);
    await alice.restoreProject(project, checkpoint);
    expect(alice.state.scopes[project].info.generation).toBe(2);
    expect(alice.records(project).task.value).toEqual({ title: 'original' });
    expect(alice.records(project, true).new.deleted).toBe(true);
    await bob.syncScope(project);
    expect(bob.records(project).task.value).toEqual({ title: 'original' });
    expect(bob.state.scopes[project].conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: { title: 'offline stale edit' } }),
      ]),
    );
    expect(bob.records(personal)).toEqual(privateBefore);
    await expect(bob.restoreProject(project, checkpoint)).rejects.toThrow(
      'Only the owner',
    );
  }, 60000);
  it('blocks deletion by an owner and automatically rotates the remaining project after a member deletes their account', async () => {
    const { alice, bob, project, bobAccount } = await shared();
    await expect(alice.account.deleteAccount()).rejects.toMatchObject({ status: 409 });
    const key = alice.state.scopes[project].key;
    const personal = await bob.createScope('personal');
    await bob.edit(personal, [
      {
        entityId: 'private',
        entityType: 'personal.document',
        value: { secret: 'private content' },
      },
    ]);
    await bob.syncScope(personal);
    await alice.invite(project, 'bob@example.test', 'viewer');
    const oldTokens = { ...bobAccount.tokens! };
    const accountId = bobAccount.account!.id;
    await bobAccount.deleteAccount();
    await expect(
      h.transport('/me', undefined, oldTokens.accessToken),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      h.transport('/sessions/refresh', { refreshToken: oldTokens.refreshToken }),
    ).rejects.toMatchObject({ status: 401 });
    const scopes = await h.db.$queryRaw<{ state: string }[]>(
      Prisma.sql`SELECT state FROM ultra_scopes WHERE id=${project}`,
    );
    expect(scopes[0].state).toBe('rotating');
    await alice.syncScope(project);
    expect(alice.state.scopes[project].info.state).toBe('active');
    expect(alice.state.scopes[project].key).not.toBe(key);
    expect(alice.state.scopes[project].info.members).toHaveLength(1);
    expect(
      await h.db.$queryRaw(Prisma.sql`SELECT * FROM ultra_scopes WHERE id=${personal}`),
    ).toEqual([]);
    expect(
      await h.db.$queryRaw(
        Prisma.sql`SELECT * FROM ultra_challenges WHERE account_id=${accountId}`,
      ),
    ).toEqual([]);
    const replacement = (await h.register('bob@example.test', 'bobby')).client;
    expect((await device(replacement)).client.state.scopes).toEqual({});
    expect(await replacement.request('/sync/invites')).toEqual({ invites: [] });
    await alice.deleteProject(project);
    await alice.account.deleteAccount();
  }, 60000);
  it('keeps device counters and exact retry receipts separate for independent accounts with the same device identifier', async () => {
    const { alice, bob, project } = await shared();
    bob.state.device.id = alice.state.device.id;
    const certificate = {
      serverId: h.config.serverId,
      accountId: bob.account.account!.id,
      deviceId: bob.state.device.id,
      publicKey: bob.state.device.certificate.publicKey,
    };
    bob.state.device.certificate = {
      ...certificate,
      signature: await sign(bob.account.unlocked!.secrets.signingPrivateKey, certificate),
    };
    await bob.edit(project, [task('Bob writes with counter one')]);
    await bob.syncScope(project);
    await alice.edit(project, [task('Alice writes with counter two')]);
    await alice.syncScope(project);
    await bob.syncScope(project);
    expect(alice.records(project)).toEqual(bob.records(project));
    const receipts = await h.db.$queryRaw<{ account_id: string }[]>(
      Prisma.sql`SELECT account_id FROM ultra_scope_receipts WHERE scope_id=${project} AND device_id=${alice.state.device.id}`,
    );
    expect(receipts).toHaveLength(2);
  }, 60000);
  it('acknowledges a lost committed response after permission downgrade and retains only unsent edits as private drafts', async () => {
    const { alice, bob, project } = await shared();
    const original = bob.account.transport;
    let drop = true;
    Object.defineProperty(bob.account, 'transport', {
      value: (async (...args) => {
        const result = await original(...args);
        if (drop && args[0].endsWith('/transactions')) {
          drop = false;
          throw new Error('Lost response after commit');
        }
        return result;
      }) satisfies Transport,
    });
    await bob.edit(project, [task('already committed')]);
    await expect(bob.syncScope(project)).rejects.toThrow('Lost response after commit');
    await bob.edit(project, [task('unsent edit after lost response')]);
    const prior = bob.state.scopes[project].info.members.find(
      (m) => m.authorization.accountId === bob.account.account!.id,
    )!;
    const authorization = { ...prior.authorization, role: 'viewer' as const };
    const membership = {
      authorization,
      signature: await sign(
        alice.account.unlocked!.secrets.signingPrivateKey,
        authorization,
      ),
    };
    // Role changes are not exposed as a product command yet; exercise the
    // real authenticated transaction path after its ACL state has changed.
    await h.db.$executeRaw(
      Prisma.sql`UPDATE ultra_scope_members SET role='viewer',membership=${JSON.stringify(membership)}::jsonb WHERE scope_id=${project} AND account_id=${bob.account.account!.id}`,
    );
    await h.db.$executeRaw(
      Prisma.sql`UPDATE ultra_scopes SET control_version=control_version+1 WHERE id=${project}`,
    );
    await bob.syncScope(project);
    expect(bob.records(project).task.value).toEqual({ title: 'already committed' });
    expect(bob.state.scopes[project].uncertain).toBeUndefined();
    expect(bob.state.scopes[project].intents).toHaveLength(0);
    expect(bob.state.scopes[project].conflicts.map((d) => d.value)).toEqual([
      { title: 'unsent edit after lost response' },
    ]);
  }, 60000);
  it('refuses a server relabelling a project as personal, for its owner and another member', async () => {
    const { alice, bob, project } = await shared();
    for (const original of [alice.account, bob.account]) {
      const substituted = new AccountClient(async (...args) => {
        const result = await original.transport(...args);
        if (args[0] === '/sync/scopes') {
          for (const scope of (result as { scopes: { kind: string }[] }).scopes)
            scope.kind = 'personal';
        }
        return result;
      });
      substituted.capabilities = original.capabilities;
      substituted.account = original.account;
      substituted.bundle = original.bundle;
      substituted.unlocked = original.unlocked;
      substituted.adoptTokens(original.tokens!);
      const fresh = (await device(substituted)).client;
      expect(!!fresh.state.scopes[project]).toBe(false);
      expect(await fresh.refreshScopes()).toEqual([]);
    }
  }, 60000);
});
