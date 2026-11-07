import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  SyncClient,
  RealtimeSync,
  createRealtimeSocket,
  type AccountClient,
  type SyncState,
} from '@ultra-tasks/account-crypto';
import { createHarness } from './ultra-account.helper';

const device = async (account: AccountClient): Promise<SyncClient> => {
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
describe('native realtime: real sockets, encrypted transactions, scoped access', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  const live: RealtimeSync[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    await Promise.all(live.splice(0).map((client) => client.stop()));
    for (const socket of sockets.splice(0)) socket.terminate();
    await h?.close();
  });
  const listen = async (): Promise<string> => {
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No socket address');
    return 'ws://127.0.0.1:' + address.port + '/api/v2/accounts/sync/events';
  };
  const connect = async (
    account: AccountClient,
    url: string,
    scopes: string[],
  ): Promise<{ socket: WebSocket; messages: string[] }> => {
    const { ticket } = await account.request<{ ticket: string }>('/sync/socket-ticket', {
      scopes,
    });
    const socket = new WebSocket(url + '?ticket=' + ticket);
    sockets.push(socket);
    const messages: string[] = [];
    socket.on('message', (data) => messages.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await expect.poll(() => messages.length).toBeGreaterThan(0);
    return { socket, messages };
  };
  it('delivers private personal wakeups only to the owning account and revokes a signed-out device', async () => {
    h = await createHarness({ privateOnly: true });
    const account = (await h.register()).client;
    const client = await device(account);
    const personal = await client.createScope('personal');
    const url = await listen();
    const { socket, messages } = await connect(account, url, [personal]);
    const other = (await h.register('other@example.test', 'otheruser')).client;
    await expect(
      other.request('/sync/socket-ticket', { scopes: [personal] }),
    ).rejects.toThrow();
    await client.edit(personal, [
      {
        entityId: 'private-title',
        entityType: 'personal.task',
        value: { title: 'Never disclose this task over the socket' },
      },
    ]);
    await client.syncScope(personal);
    await expect.poll(() => messages.length).toBeGreaterThan(1);
    const wire = messages.join('');
    expect(wire).not.toContain('Never disclose');
    expect(wire).not.toContain(account.tokens!.accessToken);
    expect(wire).not.toContain('alice@example.test');
    const sessions =
      await account.request<{ id: string; current: boolean }[]>('/sessions');
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    await account.request('/sessions/revoke', {
      sessionId: sessions.find((session) => session.current)!.id,
    });
    expect(await closed).toBe(4001);
  }, 60000);
  it('automatically uploads and pulls private encrypted edits through the opted-in scheduler', async () => {
    h = await createHarness({ privateOnly: true });
    const account = (await h.register()).client;
    const first = await device(account);
    const personal = await first.createScope('personal');
    const secondAccount = h.client();
    await secondAccount.login(
      'alice@example.test',
      'test password for encrypted accounts',
    );
    const second = await device(secondAccount);
    const url = await listen();
    for (const client of [first, second]) {
      const realtime = new RealtimeSync(client, {
        includePersonal: true,
        includeShared: false,
        socket: (ticket) => createRealtimeSocket(url + '?ticket=' + ticket),
        syncScope: (scopeId) => client.syncScope(scopeId),
        updated: () => undefined,
      });
      live.push(realtime);
      realtime.start();
    }
    await expect.poll(() => live.every((client) => client.isConnected)).toBe(true);
    await first.edit(personal, [
      {
        entityId: 'automatic',
        entityType: 'personal.task',
        value: { title: 'Automatic private edit' },
      },
    ]);
    await expect
      .poll(() => second.records(personal).automatic?.value, { timeout: 5000 })
      .toEqual({ title: 'Automatic private edit' });
  }, 60000);
  it('uses single-use tickets, refuses personal scopes, and sends no task content', async () => {
    h = await createHarness();
    const account = (await h.register()).client;
    const client = await device(account);
    const project = await client.createScope('project');
    const personal = await client.createScope('personal');
    const url = await listen();
    await expect(
      account.request('/sync/socket-ticket', { scopes: [personal] }),
    ).rejects.toMatchObject({ status: 403 });
    const { socket, messages } = await connect(account, url, [project]);
    const replay = new WebSocket(socket.url);
    sockets.push(replay);
    replay.on('error', () => undefined);
    const status = await new Promise<number>((resolve) =>
      replay.once('unexpected-response', (_, response) => {
        resolve(response.statusCode!);
        response.resume();
        replay.terminate();
      }),
    );
    expect(status).toBe(401);
    await client.edit(project, [
      {
        entityId: 'task',
        entityType: 'shared.task',
        value: { title: 'very private task title' },
      },
    ]);
    await client.syncScope(project);
    await expect.poll(() => messages.length).toBeGreaterThan(1);
    expect(messages.join('')).not.toContain('very private task title');
    expect(messages.join('')).not.toContain(account.tokens!.accessToken);
    expect(messages.join('')).not.toContain('alice@example.test');
  }, 30000);
  it('closes a revoked device subscription and leaves the other device connected', async () => {
    h = await createHarness();
    const account = (await h.register()).client;
    const client = await device(account);
    const project = await client.createScope('project');
    const other = h.client();
    await other.login('alice', 'test password for encrypted accounts');
    const url = await listen();
    const first = await connect(account, url, [project]);
    const second = await connect(other, url, [project]);
    const session = (
      await other.request<{ id: string; current: boolean }[]>('/sessions')
    ).find((s) => s.current)!;
    const closed = new Promise<number>((resolve) =>
      second.socket.once('close', (code) => resolve(code)),
    );
    await account.request('/sessions/revoke', { sessionId: session.id });
    expect(await closed).toBe(4001);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
  }, 30000);
  it('delivers independent-password edits quickly while private intents stay unsent', async () => {
    h = await createHarness();
    const alice = await device((await h.register()).client);
    const bobAccount = (await h.register('bob@example.test', 'bobby')).client;
    await bobAccount.changePassword('bobby has a completely different password');
    const bob = await device(bobAccount);
    const project = await alice.createScope('project');
    await alice.edit(project, [
      { entityId: 'task', entityType: 'shared.task', value: { title: 'initial' } },
    ]);
    await alice.syncScope(project);
    await alice.invite(project, 'bobby', 'editor');
    await bob.accept((await bob.invitations())[0]);
    const personal = await bob.createScope('personal');
    await bob.edit(personal, [
      {
        entityId: 'private',
        entityType: 'personal.overlay',
        value: { dueDay: '2026-11-05' },
      },
    ]);
    const url = await listen();
    for (const client of [alice, bob]) {
      const realtime = new RealtimeSync(client, {
        socket: (ticket) => createRealtimeSocket(url + '?ticket=' + ticket),
        updated: () => undefined,
      });
      live.push(realtime);
      realtime.start();
    }
    await expect
      .poll(() => live.every((client) => client.isConnected), { timeout: 10000 })
      .toBe(true);
    const start = performance.now();
    await alice.edit(project, [
      {
        entityId: 'task',
        entityType: 'shared.task',
        value: { title: 'realtime encrypted edit' },
      },
    ]);
    await expect
      .poll(() => (bob.records(project).task.value as { title: string }).title, {
        timeout: 10000,
        interval: 10,
      })
      .toBe('realtime encrypted edit');
    expect(performance.now() - start).toBeLessThan(1000);
    expect(bob.state.scopes[personal].intents).toHaveLength(1);
    expect(bob.state.scopes[personal].heads).toEqual({});
    await alice.removeMember(project, bobAccount.account!.id);
    await expect.poll(() => bob.state.scopes[project].revoked).toBe(true);
  }, 60000);
  it('uses HTTP fallback and preserves pending changes when sockets are unavailable', async () => {
    h = await createHarness();
    const account = (await h.register()).client;
    const first = await device(account);
    const project = await first.createScope('project');
    await first.edit(project, [
      { entityId: 'task', entityType: 'shared.task', value: { title: 'initial' } },
    ]);
    await first.syncScope(project);
    const second = await device(account);
    await second.syncScope(project);
    for (const client of [first, second]) {
      const realtime = new RealtimeSync(client, {
        socket: () => {
          throw new Error('socket unavailable');
        },
        fallbackMs: 100,
        updated: () => undefined,
      });
      live.push(realtime);
      realtime.start();
    }
    await first.edit(project, [
      {
        entityId: 'task',
        entityType: 'shared.task',
        value: { title: 'fallback delivered' },
      },
    ]);
    await expect
      .poll(() => (second.records(project).task.value as { title: string }).title, {
        timeout: 5000,
      })
      .toBe('fallback delivered');
  }, 30000);
  it('persists edits during a stalled download and lets another project finish syncing', async () => {
    h = await createHarness();
    const account = (await h.register()).client;
    const client = await device(account);
    const slow = await client.createScope('project');
    const fast = await client.createScope('project');
    await client.syncScope(slow);
    let release: () => void = () => undefined;
    let began: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = account.transport;
    Object.defineProperty(account, 'transport', {
      value: async (...args: Parameters<typeof original>) => {
        if (args[0].startsWith('/sync/scopes/' + slow + '/changes')) {
          began();
          await gate;
        }
        return original(...args);
      },
    });
    const stalled = client.syncScope(slow);
    await started;
    const edit = client.edit(slow, [
      {
        entityId: 'local',
        entityType: 'shared.task',
        value: { title: 'saved while downloading' },
      },
    ]);
    const other = client
      .edit(fast, [
        {
          entityId: 'remote',
          entityType: 'shared.task',
          value: { title: 'independent project' },
        },
      ])
      .then(() => client.syncScope(fast));
    const independent = await Promise.race([
      Promise.all([edit, other]).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    release();
    await Promise.all([stalled, edit, other]);
    expect(independent).toBe(true);
    expect(client.records(fast).remote.value).toEqual({ title: 'independent project' });
    expect(client.records(slow).local.value).toEqual({
      title: 'saved while downloading',
    });
  }, 30000);
});
