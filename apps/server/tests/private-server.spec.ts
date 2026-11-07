import { afterEach, describe, expect, it, vi } from 'vitest';
import { opaqueReady, opaqueServer } from '@ultra-tasks/account-crypto';
import { createServer } from '../src/private-server';
import { createServer as createSocket } from 'node:net';

describe('published private server entry point', () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    await server?.stop();
    vi.unstubAllEnvs();
  });

  it('serves the account dashboard and private capabilities without legacy authentication or sync endpoints', async () => {
    await opaqueReady;
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CORS_ORIGINS', '');
    vi.stubEnv('PUBLIC_URL', 'http://localhost');
    vi.stubEnv('ULTRA_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('ULTRA_SERVER_ID', crypto.randomUUID());
    vi.stubEnv('ULTRA_OPAQUE_SETUP', opaqueServer.createSetup());
    vi.stubEnv(
      'ULTRA_AUTH_SECRET',
      'a private test operator secret that is not used outside tests',
    );
    const socket = createSocket();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const address = socket.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port allocated');
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    server = createServer({
      port: address.port,
      host: '127.0.0.1',
      publicUrl: 'http://localhost',
    });
    await server.start();
    const app = server.fastifyServer!;
    expect((await app.inject('/')).headers.location).toBe('/account');
    const dashboard = await app.inject('/account');
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.headers['cache-control']).toBe('no-store');
    expect(dashboard.body).toContain('Manage your account and connected devices here.');
    const capabilities = await app.inject('/api/v2/accounts/capabilities');
    expect(capabilities.json()).toMatchObject({
      protocol: 2,
      features: { scopedSync: true, sharedProjects: false, sharedRealtime: false },
    });
    for (const legacyPath of [
      '/api/register',
      '/api/login',
      '/api/sync/ops',
      '/index.html',
    ])
      expect((await app.inject(legacyPath)).statusCode).toBe(404);
    expect((await app.inject('/live')).statusCode).toBe(200);
    const ownOrigin = await app.inject({
      url: '/live',
      headers: { origin: 'http://localhost' },
    });
    expect(ownOrigin.headers['access-control-allow-origin']).toBe('http://localhost');
    const upstreamOrigin = await app.inject({
      url: '/live',
      headers: { origin: 'https://app.super-productivity.com' },
    });
    expect(upstreamOrigin.headers['access-control-allow-origin']).toBeUndefined();
  });
});
