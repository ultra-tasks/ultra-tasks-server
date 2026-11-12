import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { unlockBundle, opaqueClient } from '@ultra-tasks/account-crypto';
import { createHarness, password } from './ultra-account.helper';
import { totp } from '../src/ultra-account/security';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe('opt-in Better Auth + existing OPAQUE/vault compatibility', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness({ authEngine: 'better-auth', privateOnly: true });
  });
  afterEach(async () => h.close());
  const count = async () =>
    Number(
      (
        await h.database.query<{ count: number }>(
          'SELECT count(*) FROM ultra_better_auth_sessions',
        )
      ).rows[0].count,
    );

  it('reads an existing native account, preserves its vault, and uses real hashed Better Auth sessions', async () => {
    h.config.authEngine = 'native';
    const { client, prepared } = await h.register();
    const oldToken = client.tokens!.accessToken;
    const before = (await h.database.query('SELECT * FROM ultra_accounts')).rows;
    const masterKey = client.unlocked!.masterKey;
    h.config.authEngine = 'better-auth';
    const fresh = h.client();
    await fresh.login('alice', password);
    expect(fresh.tokens!.accessToken).toMatch(/^utba1_/);
    expect(fresh.unlocked!.masterKey).toBe(masterKey);
    expect((await h.database.query('SELECT * FROM ultra_accounts')).rows).toEqual(before);
    expect(
      (
        await unlockBundle(fresh.bundle!, fresh.identity(), {
          recoveryKey: prepared.recoveryKey,
        })
      ).masterKey,
    ).toBe(masterKey);
    await expect(h.transport('/me', undefined, oldToken)).resolves.toBeDefined();
    expect(await count()).toBe(1);
    const stored = JSON.stringify(
      (await h.database.query('SELECT * FROM ultra_better_auth_sessions')).rows,
    );
    expect(stored).not.toContain(fresh.tokens!.accessToken.slice(6));
    expect(stored).not.toContain(masterKey);
    expect(stored).not.toContain(password);
    expect(h.requests.join('')).not.toContain(password);
    expect(h.requests.join('')).not.toContain(prepared.recoveryKey);
  });

  it('does not grant a session before verification or for a wrong password; plaintext-password routes are absent', async () => {
    const client = h.client();
    await client.register(
      await client.prepareRegistration(
        {
          email: 'unverified@example.test',
          displayName: 'Unverified',
        },
        password,
      ),
    );
    await expect(client.login('unverified@example.test', password)).rejects.toThrow();
    expect(await count()).toBe(0);
    await h.transport('/verify-email', {
      identifier: 'unverified@example.test',
      code: h.mail[0].token,
    });
    await expect(
      client.login('unverified@example.test', 'a wrong account password'),
    ).rejects.toThrow();
    expect(await count()).toBe(0);
    for (const url of [
      '/api/auth/sign-in/email',
      '/api/auth/reset-password',
      '/api/auth/ultra/opaque/finish',
    ]) {
      const response = await h.app.inject({ method: 'POST', url, payload: {} });
      expect(response.statusCode).toBe(404);
    }
  });

  it('enforces TOTP/recovery codes before issuing Better Auth access and rejects repeated proofs', async () => {
    const { client } = await h.register();
    const enrollment = await client.request<{ enrollmentToken: string; secret: string }>(
      '/factors/totp/start',
      {},
    );
    const codes = await client.request<{ recoveryCodes: string[] }>(
      '/factors/totp/finish',
      {
        enrollmentToken: enrollment.enrollmentToken,
        code: totp(enrollment.secret),
      },
    );
    const existing = await count();
    const login = h.client();
    const pending = await login.login('alice', password);
    expect(pending.accessToken).toBeUndefined();
    expect(pending.refreshToken).toBeUndefined();
    expect(await count()).toBe(existing);
    await expect(h.transport('/me', undefined, pending.mfaToken)).rejects.toThrow();
    await expect(login.completeMfa('invalid')).rejects.toThrow();
    expect(await count()).toBe(existing);
    await login.completeMfa(codes.recoveryCodes[0]);
    expect(login.tokens!.accessToken).toMatch(/^utba1_/);
    expect(login.unlocked).toBeDefined();
    const second = h.client();
    await second.login('alice', password);
    await expect(second.completeMfa(codes.recoveryCodes[0])).rejects.toThrow();
  });

  it('expires access in ten minutes, refreshes once, and revokes the device on refresh reuse', async () => {
    const { client } = await h.register();
    const accessToken = client.tokens!.accessToken;
    const refreshToken = client.tokens!.refreshToken;
    const row = (
      await h.database.query<{ id: string; data: Record<string, unknown> }>(
        'SELECT id,data FROM ultra_better_auth_sessions',
      )
    ).rows[0];
    expect(Date.parse(String(row.data.expiresAt)) - Date.now()).toBeGreaterThan(590000);
    expect(Date.parse(String(row.data.expiresAt)) - Date.now()).toBeLessThanOrEqual(
      600000,
    );
    const expired = { ...row.data, expiresAt: new Date(Date.now() - 1000).toISOString() };
    await h.db.$executeRaw(
      Prisma.sql`UPDATE ultra_better_auth_sessions SET data=${JSON.stringify(expired)}::jsonb WHERE id=${row.id}`,
    );
    await expect(h.transport('/me', undefined, accessToken)).rejects.toThrow();
    const rotated = (await h.transport('/sessions/refresh', { refreshToken })) as {
      accessToken: string;
      refreshToken: string;
    };
    expect(rotated.accessToken).toMatch(/^utba1_/);
    expect(rotated.accessToken).not.toBe(accessToken);
    await expect(
      h.transport('/me', undefined, rotated.accessToken),
    ).resolves.toBeDefined();
    expect(await count()).toBe(1);
    await expect(h.transport('/sessions/refresh', { refreshToken })).rejects.toThrow();
    await expect(h.transport('/me', undefined, rotated.accessToken)).rejects.toThrow();
  });

  it('changes and recovers passwords while preserving vault keys and revoking old sessions', async () => {
    const { client, prepared } = await h.register();
    const masterKey = client.unlocked!.masterKey;
    const ciphertext = client.bundle!.vault;
    const old = client.tokens!.accessToken;
    await client.changePassword('a changed better auth account password');
    expect(client.tokens!.accessToken).toMatch(/^utba1_/);
    expect(client.bundle!.vault).toEqual(ciphertext);
    expect(client.unlocked!.masterKey).toBe(masterKey);
    await expect(h.transport('/me', undefined, old)).rejects.toThrow();
    await h.transport('/recovery/request', { identifier: 'alice' });
    const mail = h.mail.findLast((message) => message.kind === 'recover')!;
    await h
      .client()
      .recover(mail.token, prepared.recoveryKey, 'a recovered better auth password');
    const recovered = h.client();
    await recovered.login('alice', 'a recovered better auth password');
    expect(recovered.unlocked!.masterKey).toBe(masterKey);
    await expect(client.request('/me')).rejects.toThrow();
  });

  it('consumes the OPAQUE login proof only once', async () => {
    await h.register();
    const started = opaqueClient.startLogin({ password });
    const response = (await h.transport('/login/start', {
      identifier: 'alice',
      startLoginRequest: started.startLoginRequest,
    })) as { loginToken: string; loginResponse: string };
    const proof = opaqueClient.finishLogin({
      ...started,
      password,
      loginResponse: response.loginResponse,
      keyStretching: 'memory-constrained',
    })!;
    const request = {
      loginToken: response.loginToken,
      finishLoginRequest: proof.finishLoginRequest,
    };
    await h.transport('/login/finish', request);
    await expect(h.transport('/login/finish', request)).rejects.toThrow();
  });

  it('upgrades native refresh to Better Auth and supports a native rollback without changing the vault', async () => {
    h.config.authEngine = 'native';
    const { client } = await h.register();
    const bundle = client.bundle;
    const masterKey = client.unlocked!.masterKey;
    const native = client.tokens!;
    expect(native.accessToken).not.toMatch(/^utba1_/);
    h.config.authEngine = 'better-auth';
    const upgraded = (await h.transport('/sessions/refresh', {
      refreshToken: native.refreshToken,
    })) as { accessToken: string; refreshToken: string };
    expect(upgraded.accessToken).toMatch(/^utba1_/);
    const account = (await h.transport('/me', undefined, upgraded.accessToken)) as {
      bundle: typeof bundle;
    };
    expect(account.bundle).toEqual(bundle);
    h.config.authEngine = 'native';
    await expect(h.transport('/me', undefined, upgraded.accessToken)).rejects.toThrow();
    const rolledBack = (await h.transport('/sessions/refresh', {
      refreshToken: upgraded.refreshToken,
    })) as { accessToken: string; refreshToken: string };
    expect(rolledBack.accessToken).not.toMatch(/^utba1_/);
    await expect(
      h.transport('/me', undefined, rolledBack.accessToken),
    ).resolves.toBeDefined();
    const fresh = h.client();
    await fresh.login('alice', password);
    expect(fresh.unlocked!.masterKey).toBe(masterKey);
    expect(fresh.bundle).toEqual(bundle);
    await expect(
      h.transport('/sessions/refresh', {
        refreshToken: native.refreshToken,
      }),
    ).rejects.toThrow();
  });
});
