import { afterEach, describe, expect, it, vi } from 'vitest';
import { opaqueReady, opaqueServer } from '@ultra-tasks/account-crypto';
import { createServer as createSocket } from 'node:net';
import { createServer } from '../src/private-server';
import { parsePrivacyPolicyUrl } from '../src/privacy-url';

const POLICY = 'https://ultratasks.app/privacy-policy/';

describe('parsePrivacyPolicyUrl', () => {
  it('treats a missing or blank value as "serve the operator file"', () => {
    expect(parsePrivacyPolicyUrl(undefined)).toBeUndefined();
    expect(parsePrivacyPolicyUrl('')).toBeUndefined();
    expect(parsePrivacyPolicyUrl('   ')).toBeUndefined();
  });

  it('accepts an HTTPS address, and plain HTTP only on a loopback host', () => {
    expect(parsePrivacyPolicyUrl(`  ${POLICY}\n`)).toBe(POLICY);
    expect(parsePrivacyPolicyUrl('https://example.com')).toBe('https://example.com/');
    expect(parsePrivacyPolicyUrl('http://localhost:4321/privacy-policy/')).toBe(
      'http://localhost:4321/privacy-policy/',
    );
    expect(parsePrivacyPolicyUrl('http://127.0.0.1:4321/')).toBe(
      'http://127.0.0.1:4321/',
    );
  });

  it('refuses anything else without repeating the value', () => {
    for (const bad of [
      'http://remote.example/privacy',
      'https://user:secret@example.com/privacy',
      'javascript:alert(1)',
      'ftp://example.com/privacy',
      'ultratasks.app/privacy-policy',
      '/privacy-policy/',
    ]) {
      let message = '';
      try {
        parsePrivacyPolicyUrl(bad);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, bad).toMatch(/^ULTRA_PRIVACY_URL must be /);
      expect(message).not.toMatch(/secret|remote\.example|javascript|ftp/);
    }
  });
});

describe('private server privacy policy address', () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    vi.unstubAllEnvs();
  });

  const configure = async (env: Record<string, string>) => {
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
    // No operator documents on disk: the only privacy policy is the address.
    vi.stubEnv('ULTRA_LEGAL_DIR', '/nonexistent/operator-legal');
    vi.stubEnv('ULTRA_REGISTRATION_OPEN', 'true');
    vi.stubEnv('ULTRA_REQUIRE_TERMS_CONSENT', 'true');
    vi.stubEnv('ULTRA_PRIVACY_URL', '');
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  };

  const freePort = async () => {
    const socket = createSocket();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const address = socket.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port allocated');
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    return address.port;
  };

  it('redirects /privacy.html to the published policy and lets registration open without a file', async () => {
    await configure({ ULTRA_PRIVACY_URL: POLICY });
    server = createServer({
      port: await freePort(),
      host: '127.0.0.1',
      publicUrl: 'http://localhost',
    });
    await server.start();
    const app = server.fastifyServer!;

    const privacy = await app.inject('/privacy.html');
    expect(privacy.statusCode).toBe(302);
    expect(privacy.headers.location).toBe(POLICY);
    expect(privacy.headers['cache-control']).toBe('no-store');
    // No Terms of Service were supplied, so there is nothing to publish there.
    expect((await app.inject('/terms.html')).statusCode).toBe(404);

    // The sign-up page still links to /privacy.html, which is what redirects.
    const dashboard = await app.inject('/account');
    expect(dashboard.body).toContain('href="/privacy.html"');
    const capabilities = await app.inject('/api/v2/accounts/capabilities');
    expect(capabilities.json()).toMatchObject({ requireTermsConsent: true });
  });

  it('refuses to open registration with consent required and no policy at all', async () => {
    await configure({});
    expect(() => createServer({ publicUrl: 'http://localhost' })).toThrow(
      /Set ULTRA_PRIVACY_URL or provide operator\/legal\/privacy\.html/,
    );
  });

  it('refuses to start with a policy address that is not HTTPS, without echoing it', async () => {
    await configure({ ULTRA_PRIVACY_URL: 'http://remote.example/privacy-policy/' });
    let message = '';
    try {
      createServer({ publicUrl: 'http://localhost' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^ULTRA_PRIVACY_URL must be an HTTPS URL/);
    expect(message).not.toContain('remote.example');
  });
});
