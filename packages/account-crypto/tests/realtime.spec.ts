import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeSync, type RealtimeSocket } from '../src/realtime';
import type { SyncClient } from '../src/sync-client';

interface Fixture {
  realtime: RealtimeSync;
  updated: ReturnType<typeof vi.fn>;
  socket: RealtimeSocket;
  syncScope: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
  request: ReturnType<typeof vi.fn>;
  edit: (id: string) => void;
}
const fixture = (): Fixture => {
  let listener: (id: string) => void = () => undefined;
  const socket: RealtimeSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: vi.fn(),
  };
  const syncScope = vi.fn(async (_id: string): Promise<void> => undefined);
  const state = {
    scopes: {
      a: { info: { id: 'a', kind: 'project' } },
      b: { info: { id: 'b', kind: 'project' } },
      personal: { info: { id: 'personal', kind: 'personal' } },
    },
  };
  const request = vi.fn(async () => ({ ticket: 'single-use-ticket' }));
  const client = {
    state,
    syncScope,
    account: { request },
    subscribeLocal: (fn: typeof listener) => {
      listener = fn;
      return () => {
        listener = () => undefined;
      };
    },
  } as unknown as SyncClient;
  const updated = vi.fn();
  const realtime = new RealtimeSync(client, { socket: () => socket, updated });
  return {
    realtime,
    updated,
    socket,
    syncScope,
    request,
    edit: (id: string) => listener(id),
  };
};
describe('foreground shared scope scheduling', () => {
  afterEach(() => vi.useRealTimers());
  it('bounds continuous edit batching to one second and never uploads personal edits', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    f.syncScope.mockClear();
    for (let ms = 0; ms < 1000; ms += 50) {
      f.edit('a');
      f.edit('personal');
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(f.syncScope.mock.calls).toEqual([['a']]);
    expect(f.request).toHaveBeenCalledWith('/sync/socket-ticket', { scopes: ['a', 'b'] });
    await f.realtime.stop();
  });
  it('lets another scope run while a continuously edited project is busy and stops all work on lock', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    f.syncScope.mockClear();
    let release: () => void = () => undefined;
    f.syncScope.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    f.edit('a');
    await vi.advanceTimersByTimeAsync(150);
    f.edit('a');
    f.edit('b');
    await vi.advanceTimersByTimeAsync(150);
    expect(f.syncScope.mock.calls).toEqual([['a'], ['b']]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.syncScope.mock.calls).toEqual([['a'], ['b'], ['a']]);
    await f.realtime.stop();
    const before = f.syncScope.mock.calls.length;
    f.edit('a');
    f.socket.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.syncScope).toHaveBeenCalledTimes(before);
    expect(f.socket.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('isolates failed scopes and catches up promptly after reconnect without waiting for the private interval', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    f.syncScope.mockClear();
    f.syncScope.mockRejectedValueOnce(new Error('Unavailable project'));
    f.edit('a');
    f.edit('b');
    await vi.advanceTimersByTimeAsync(150);
    expect(f.syncScope.mock.calls).toEqual([['a'], ['b']]);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.syncScope.mock.calls.at(-1)).toEqual(['a']);
    f.syncScope.mockClear();
    f.realtime.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.syncScope.mock.calls).toEqual([['a'], ['b']]);
    await f.realtime.stop();
  });
});
