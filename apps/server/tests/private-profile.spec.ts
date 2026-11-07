import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountApiError,
  SyncClient,
  type StateStorage,
  type SyncState,
} from '@ultra-tasks/account-crypto';
import { createHarness } from './ultra-account.helper';

const storage = (): StateStorage => {
  let state: SyncState | null = null;
  return {
    async load() {
      return structuredClone(state);
    },
    async save(value) {
      state = structuredClone(value);
    },
  };
};

describe('private account production profile', () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  afterEach(async () => harness?.close());

  it('advertises private sync and refuses project creation and sharing routes', async () => {
    harness = await createHarness({ privateOnly: true });
    const capabilities = await harness.transport('/capabilities');
    expect(capabilities).toMatchObject({
      protocol: 2,
      features: { scopedSync: true, sharedProjects: false, sharedRealtime: false },
    });
    const { client: account } = await harness.register();
    const sync = new SyncClient(account, storage());
    await sync.init();
    await expect(sync.createScope('project')).rejects.toMatchObject({ status: 403 });
    for (const route of ['/sync/invites', '/sync/ownership/offers']) {
      await expect(
        harness.transport(route, undefined, account.tokens!.accessToken),
      ).rejects.toMatchObject({ status: 404 });
    }
    await expect(
      harness.transport(
        '/sync/recipients',
        { identifier: 'alice' },
        account.tokens!.accessToken,
      ),
    ).rejects.toMatchObject({ status: 404 });
  }, 60000);

  it('keeps personal encrypted data usable across devices and isolated from another account', async () => {
    harness = await createHarness({ privateOnly: true });
    const { client: account } = await harness.register();
    const first = new SyncClient(account, storage());
    await first.init();
    const scopeId = await first.migrate([
      {
        entityId: 'task-private',
        entityType: 'personal.task',
        value: { title: 'Only my devices' },
      },
    ]);
    const secondAccount = harness.client();
    await secondAccount.login(
      'alice@example.test',
      'test password for encrypted accounts',
    );
    const second = new SyncClient(secondAccount, storage());
    await second.init();
    await second.refreshScopes();
    await second.syncScope(scopeId);
    expect(second.records(scopeId)['task-private'].value).toEqual({
      title: 'Only my devices',
    });

    const other = await harness.register('bob@example.test', 'bobby');
    await expect(
      harness.transport(
        '/sync/scopes/' + scopeId + '/snapshot',
        undefined,
        other.client.tokens!.accessToken,
      ),
    ).rejects.toBeInstanceOf(AccountApiError);
  }, 60000);

  it('hides an existing project and rejects direct access without deleting its data', async () => {
    harness = await createHarness();
    const { client: account } = await harness.register();
    const sync = new SyncClient(account, storage());
    await sync.init();
    const project = await sync.createScope('project');
    harness.config.privateOnly = true;
    const visible = await harness.transport(
      '/sync/scopes',
      undefined,
      account.tokens!.accessToken,
    );
    expect(visible).toEqual({ scopes: [] });
    await expect(
      harness.transport(
        '/sync/scopes/' + project + '/snapshot',
        undefined,
        account.tokens!.accessToken,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await harness.database.query('SELECT id FROM ultra_scopes')).rows).toEqual([
      { id: project },
    ]);
  }, 60000);
});
