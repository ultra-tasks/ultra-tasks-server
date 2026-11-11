import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountClient,
  AccountApiError,
  SyncClient,
  type SyncState,
  type StateStorage,
  type Transport,
  type Mutation,
  type ScopeSnapshot,
} from '@ultra-tasks/account-crypto';
import { Prisma } from '@prisma/client';
import { createHarness, password } from './ultra-account.helper';

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
    await expect(second.syncScope(id)).rejects.toThrow(
      'omitted a record this device already has',
    );
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
