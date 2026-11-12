import { afterEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  AccountClient,
  SyncClient,
  encryptRecord,
  fingerprint,
  restorePersonal,
  sign,
  type Mutation,
  type StateStorage,
  type SyncState,
} from '@ultra-tasks/account-crypto';
import { createHarness } from './ultra-account.helper';

const memory = (): StateStorage => {
  let value: SyncState | null = null;
  return {
    load: async () => structuredClone(value),
    save: async (state) => {
      value = structuredClone(state);
    },
  };
};

const device = async (account: AccountClient): Promise<SyncClient> => {
  const client = new SyncClient(account, memory());
  await client.init();
  return client;
};

const replacement = async (
  client: SyncClient,
  scopeId: string,
  count: number,
  duplicate = false,
  omitPriorHeads = false,
) => {
  const account = client.account;
  const scope = client.state.scopes[scopeId];
  const { serverId, accountId } = account.identity();
  const { device } = client.state;
  const next = Array.from({ length: count }, (_, index) => ({
    entityId: `new-${duplicate && index === 100 ? 0 : index}`,
    entityType: 'personal.task',
    value: { title: `new private ${index}` },
    deleted: false,
  }));
  const nextIds = new Set(next.map((record) => record.entityId));
  const inventory = [
    ...next,
    ...(omitPriorHeads
      ? []
      : Object.values(client.records(scopeId, true))
          .filter((head) => !nextIds.has(head.entityId))
          .map((head) => ({
            entityId: head.entityId,
            entityType: head.entityType,
            value: null,
            deleted: true,
          }))),
  ];
  const mutations: Mutation[] = [];
  for (let offset = 0; offset < inventory.length; offset += 100) {
    const mutationId = crypto.randomUUID();
    const counter = scope.counter + 1 + mutations.length;
    const writes = await Promise.all(
      inventory.slice(offset, offset + 100).map(async (item) => {
        const header = {
          v: 2 as const,
          serverId,
          scopeId,
          entityId: item.entityId,
          entityType: item.entityType,
          actorId: accountId,
          deviceId: device.id,
          mutationId,
          epoch: scope.info.epoch,
          generation: scope.info.generation + 1,
          controlVersion: scope.info.controlVersion,
          counter,
          baseRevision: 0,
          revision: 1,
        };
        return {
          record: await encryptRecord(
            header,
            { value: item.value, deleted: item.deleted },
            scope.key,
            device.privateKey,
          ),
          deleted: item.deleted,
        };
      }),
    );
    const data = {
      v: 2 as const,
      serverId,
      scopeId,
      epoch: scope.info.epoch,
      generation: scope.info.generation + 1,
      controlVersion: scope.info.controlVersion,
      deviceId: device.id,
      counter,
      mutationId,
      certificate: device.certificate,
      membership: scope.info.members[0],
      writes,
    };
    mutations.push({ ...data, signature: await sign(device.privateKey, data) });
  }
  const start = {
    action: 'start-personal-replacement',
    serverId,
    scopeId,
    id: crypto.randomUUID(),
    deviceId: device.id,
    sequence: scope.info.sequence,
    generation: scope.info.generation,
    controlVersion: scope.info.controlVersion,
    count: inventory.length,
    batches: await Promise.all(mutations.map((value) => fingerprint(value))),
  };
  const signedStart = {
    ...start,
    signature: await sign(account.unlocked!.secrets.signingPrivateKey, start),
  };
  const finish = {
    action: 'finish-personal-replacement',
    serverId,
    scopeId,
    id: start.id,
  };
  return {
    start,
    mutations,
    begin: () =>
      account.request(`/sync/scopes/${scopeId}/replacement/start`, signedStart),
    stage: (mutation: Mutation) =>
      account.request(`/sync/scopes/${scopeId}/replacement/stage`, {
        id: start.id,
        mutation,
      }),
    finish: async () =>
      account.request(`/sync/scopes/${scopeId}/replacement/finish`, {
        ...finish,
        signature: await sign(account.unlocked!.secrets.signingPrivateKey, finish),
      }),
  };
};

describe('atomic personal provider replacement', () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  afterEach(async () => {
    await harness?.close();
  });

  it('keeps the old dataset visible until every authenticated batch commits, then converges', async () => {
    harness = await createHarness({ privateOnly: true });
    const account = (await harness.register()).client;
    const first = await device(account);
    const scopeId = await first.migrate([
      { entityId: 'old', entityType: 'personal.task', value: { title: 'old private' } },
    ]);
    const observer = await device(account);
    await observer.refreshScopes();
    await observer.syncScope(scopeId);
    const job = await replacement(first, scopeId, 120);
    await job.begin();
    await job.stage(job.mutations[0]);
    await observer.syncScope(scopeId);
    expect(Object.keys(observer.records(scopeId))).toEqual(['old']);
    await expect(job.finish()).rejects.toThrow();
    await job.stage(job.mutations[1]);
    await job.finish();
    // A lost response can be retried without creating another generation.
    await job.stage(job.mutations[1]);
    await job.finish();
    await observer.syncScope(scopeId);
    expect(Object.keys(observer.records(scopeId))).toHaveLength(120);
    expect(observer.records(scopeId).old).toBeUndefined();
    expect(observer.records(scopeId)['new-119'].value).toEqual({
      title: 'new private 119',
    });
    expect(observer.state.scopes[scopeId].info.generation).toBe(2);
    await first.syncScope(scopeId);
    await first.edit(scopeId, [
      {
        entityId: 'new-0',
        entityType: 'personal.task',
        value: { title: 'edited after replacement' },
      },
    ]);
    await first.syncScope(scopeId);
    await observer.syncScope(scopeId);
    expect(observer.records(scopeId)['new-0'].value).toEqual({
      title: 'edited after replacement',
    });
    expect(
      JSON.stringify(
        await harness.db.$queryRaw(Prisma.sql`SELECT write FROM ultra_record_heads`),
      ),
    ).not.toContain('new private');
  }, 60000);

  it('rejects a stale choice without changing either dataset', async () => {
    harness = await createHarness({ privateOnly: true });
    const account = (await harness.register()).client;
    const first = await device(account);
    const scopeId = await first.migrate([
      { entityId: 'old', entityType: 'personal.task', value: { title: 'old' } },
    ]);
    const other = await device(account);
    await other.refreshScopes();
    await other.syncScope(scopeId);
    const job = await replacement(first, scopeId, 1);
    await job.begin();
    await job.stage(job.mutations[0]);
    await other.edit(scopeId, [
      { entityId: 'other', entityType: 'personal.task', value: { title: 'concurrent' } },
    ]);
    await other.syncScope(scopeId);
    await expect(job.finish()).rejects.toThrow();
    await first.syncScope(scopeId);
    expect(Object.keys(first.records(scopeId)).sort()).toEqual(['old', 'other']);
  }, 60000);

  it('preserves a disconnected device edit as a draft when its record is replaced', async () => {
    harness = await createHarness({ privateOnly: true });
    const account = (await harness.register()).client;
    const first = await device(account);
    const original = { path: ['task', 'entities', 'old'], data: { title: 'original' } };
    const edited = { path: ['task', 'entities', 'old'], data: { title: 'offline edit' } };
    const deletedOriginal = {
      path: ['task', 'entities', 'deleted'],
      data: { title: 'already deleted on the server' },
    };
    const deletedEdit = {
      path: ['task', 'entities', 'deleted'],
      data: { title: 'offline edit to deleted task' },
    };
    const scopeId = await first.migrate([
      { entityId: 'old', entityType: 'personal.document', value: original },
      { entityId: 'deleted', entityType: 'personal.document', value: deletedOriginal },
    ]);
    const offline = await device(account);
    await offline.refreshScopes();
    await offline.syncScope(scopeId);
    await first.edit(scopeId, [
      {
        entityId: 'deleted',
        entityType: 'personal.document',
        value: null,
        deleted: true,
      },
    ]);
    await first.syncScope(scopeId);
    await first.syncScope(scopeId);
    await offline.edit(scopeId, [
      { entityId: 'old', entityType: 'personal.document', value: edited },
      { entityId: 'deleted', entityType: 'personal.document', value: deletedEdit },
    ]);
    const job = await replacement(first, scopeId, 1);
    await job.begin();
    for (const batch of job.mutations) await job.stage(batch);
    await job.finish();
    await offline.syncScope(scopeId);
    expect(() => restorePersonal(offline.records(scopeId))).not.toThrow();
    expect(offline.records(scopeId).old).toBeUndefined();
    expect(offline.records(scopeId).deleted).toBeUndefined();
    expect(offline.state.scopes[scopeId].conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: 'old', value: edited }),
        expect.objectContaining({ entityId: 'deleted', value: deletedEdit }),
      ]),
    );
    await first.syncScope(scopeId);
    expect(first.records(scopeId).old).toBeUndefined();
    expect(() => restorePersonal(first.records(scopeId))).not.toThrow();
  }, 60000);

  it('rejects a replacement that omits a previous head', async () => {
    harness = await createHarness({ privateOnly: true });
    const account = (await harness.register()).client;
    const first = await device(account);
    const scopeId = await first.migrate([
      { entityId: 'old', entityType: 'personal.task', value: { title: 'original' } },
    ]);
    const job = await replacement(first, scopeId, 1, false, true);
    await job.begin();
    for (const batch of job.mutations) await job.stage(batch);
    await expect(job.finish()).rejects.toThrow('missing prior record tombstones');
    await first.syncScope(scopeId);
    expect(first.records(scopeId).old.value).toEqual({ title: 'original' });
  }, 60000);

  it('rejects reusing a previous record id with a different entity type', async () => {
    harness = await createHarness({ privateOnly: true });
    const account = (await harness.register()).client;
    const first = await device(account);
    const value = { path: ['task', 'entities', 'old'], data: { title: 'original' } };
    const scopeId = await first.migrate([
      { entityId: 'new-0', entityType: 'personal.document', value },
    ]);
    const job = await replacement(first, scopeId, 1);
    await job.begin();
    for (const batch of job.mutations) await job.stage(batch);
    await expect(job.finish()).rejects.toThrow('changed a prior record type');
    await first.syncScope(scopeId);
    expect(first.records(scopeId)['new-0'].value).toEqual(value);
  }, 60000);

  it('rejects altered and unauthorized batches and keeps live data untouched', async () => {
    harness = await createHarness({ privateOnly: true });
    const account = (await harness.register()).client;
    const first = await device(account);
    const scopeId = await first.migrate([
      { entityId: 'old', entityType: 'personal.task', value: { title: 'original' } },
    ]);
    const job = await replacement(first, scopeId, 1);
    const badStart = {
      ...job.start,
      count: job.start.count + 1,
      signature: await sign(account.unlocked!.secrets.signingPrivateKey, job.start),
    };
    await expect(
      account.request(`/sync/scopes/${scopeId}/replacement/start`, badStart),
    ).rejects.toThrow();
    await job.begin();
    const changed = structuredClone(job.mutations[0]);
    changed.writes[0].record.header.entityId = 'substituted';
    await expect(job.stage(changed)).rejects.toThrow();
    const stranger = (await harness.register('other@example.test', 'other')).client;
    await expect(
      stranger.request(`/sync/scopes/${scopeId}/replacement/stage`, {
        id: job.start.id,
        mutation: job.mutations[0],
      }),
    ).rejects.toThrow();
    await expect(job.finish()).rejects.toThrow();
    await first.syncScope(scopeId);
    expect(Object.keys(first.records(scopeId))).toEqual(['old']);
  }, 60000);

  it('rejects duplicate records across batches and permits a fresh retry', async () => {
    harness = await createHarness({ privateOnly: true });
    const account = (await harness.register()).client;
    const first = await device(account);
    const scopeId = await first.migrate([
      { entityId: 'old', entityType: 'personal.task', value: { title: 'original' } },
    ]);
    const invalid = await replacement(first, scopeId, 101, true);
    await invalid.begin();
    for (const batch of invalid.mutations) await invalid.stage(batch);
    await expect(invalid.finish()).rejects.toThrow('Duplicate replacement record');
    const retry = await replacement(first, scopeId, 1);
    await retry.begin();
    await expect(invalid.finish()).rejects.toThrow();
    await retry.stage(retry.mutations[0]);
    await retry.finish();
    await first.syncScope(scopeId);
    expect(Object.keys(first.records(scopeId))).toEqual(['new-0']);
  }, 60000);
});
