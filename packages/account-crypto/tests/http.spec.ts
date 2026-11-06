import { afterEach, expect, it, vi } from 'vitest';
import { httpTransport } from '../src/account-client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('bounds stalled account requests and reports a network failure so cached offline unlock remains usable', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, options: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    ),
  );
  const result = httpTransport('https://sync.example.test')('/capabilities').catch(
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(30000);
  expect(await result).toBeInstanceOf(TypeError);
  expect(vi.getTimerCount()).toBe(0);
});
