import { describe, it, expect } from 'vitest';
import {
  AccountClient,
  SyncClient,
  RealtimeSync,
  createRealtimeSocket,
  httpTransport,
  type SyncState,
} from '@ultra-tasks/account-crypto';
import { createHarness } from './ultra-account.helper';

const device = async (account: AccountClient) => {
  let state: SyncState | null = null;
  const client = new SyncClient(account, {
    load: async () => structuredClone(state),
    save: async (value) => {
      state = structuredClone(value);
    },
  });
  await client.init();
  await client.refreshScopes();
  return client;
};
describe('declared native foreground latency target', () => {
  it('delivers to 20 members × 5 independent devices with p95 below one second', async () => {
    const h = await createHarness();
    const live: RealtimeSync[] = [];
    try {
      await h.app.listen({ host: '127.0.0.1', port: 0 });
      const address = h.app.server.address();
      if (!address || typeof address === 'string') throw new Error('No server');
      const origin = 'http://127.0.0.1:' + address.port;
      const accounts: AccountClient[] = [];
      for (let i = 0; i < 20; i++)
        accounts.push(
          (await h.register('load' + i + '@example.test', 'member' + i)).client,
        );
      const owner = await device(accounts[0]);
      const scope = await owner.createScope('project');
      await owner.edit(scope, [
        { entityId: 'task', entityType: 'shared.task', value: { title: 'version-0' } },
      ]);
      await owner.syncScope(scope);
      for (const account of accounts.slice(1)) {
        await owner.invite(scope, account.account!.username!, 'editor');
        const peer = await device(account);
        await peer.accept((await peer.invitations())[0]);
      }
      const devices: SyncClient[] = [];
      // Authentication cost is outside the delivery measurement. Five devices
      // use each account's session, with distinct certified device signing keys.
      for (const account of accounts)
        for (let i = 0; i < 5; i++) {
          const network = new AccountClient(httpTransport(origin));
          network.capabilities = account.capabilities;
          network.account = account.account;
          network.bundle = account.bundle;
          network.unlocked = account.unlocked;
          network.adoptTokens(account.tokens!);
          const peer = await device(network);
          await peer.syncScope(scope);
          devices.push(peer);
        }
      let started = 0;
      let target = '';
      const samples: number[] = [];
      const seen = new Set<SyncClient>();
      for (const peer of devices) {
        const runtime = new RealtimeSync(peer, {
          socket: (ticket) =>
            createRealtimeSocket(
              origin.replace('http:', 'ws:') +
                '/api/v2/accounts/sync/events?ticket=' +
                ticket,
            ),
          updated: () => {
            if (
              started &&
              !seen.has(peer) &&
              (peer.records(scope).task?.value as { title: string })?.title === target
            ) {
              seen.add(peer);
              samples.push(performance.now() - started);
            }
          },
        });
        live.push(runtime);
        runtime.start();
      }
      await expect
        .poll(() => live.every((runtime) => runtime.isConnected), { timeout: 30000 })
        .toBe(true);
      for (let iteration = 1; iteration <= 10; iteration++) {
        seen.clear();
        target = 'version-' + iteration;
        started = performance.now();
        await devices[iteration % devices.length].edit(scope, [
          { entityId: 'task', entityType: 'shared.task', value: { title: target } },
        ]);
        await expect.poll(() => seen.size, { timeout: 30000, interval: 10 }).toBe(100);
        started = 0;
      }
      const sorted = samples.sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
      process.stdout.write(
        JSON.stringify({
          members: 20,
          devices: 100,
          samples: sorted.length,
          p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
          p95Ms: p95,
          maxMs: sorted.at(-1),
          database: 'PGlite',
          transport: 'HTTP and WebSocket loopback',
        }) + '\n',
      );
      expect(p95).toBeLessThan(1000);
    } finally {
      await Promise.all(live.map((runtime) => runtime.stop()));
      await h.close();
    }
  }, 240000);
});
