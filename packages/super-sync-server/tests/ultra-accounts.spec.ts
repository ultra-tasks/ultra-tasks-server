import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createHarness, password } from './ultra-account.helper';
import { totp, totpStep, digest } from '../src/ultra-account/security';
import { unlockBundle, randomKey } from '@ultra-tasks/account-crypto';

// Production-strength Argon2/OPAQUE can exceed the default 5s under parallel suite load.
vi.setConfig({ testTimeout: 20000, hookTimeout: 30000 });

describe('Ultra accounts: real routes, real PostgreSQL SQL and real client cryptography', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('honors the operator consent policy before account enrollment and records acceptance', async () => {
    const required = await createHarness({
      requireTermsConsent: true,
      hasOperatorTerms: true,
    });
    try {
      const client = required.client();
      await expect(
        client.prepareRegistration(
          { email: 'consent@example.test', displayName: 'Consent' },
          password,
        ),
      ).rejects.toThrow('privacy policy');
      const prepared = await client.prepareRegistration(
        { email: 'consent@example.test', displayName: 'Consent', termsAccepted: true },
        password,
      );
      await client.register(prepared);
      const rows = await required.database.query<{ terms_accepted_at: number }>(
        'SELECT terms_accepted_at FROM ultra_accounts',
      );
      expect(Number(rows.rows[0].terms_accepted_at)).toBeGreaterThan(0);
    } finally {
      await required.close();
    }
  });

  it('requires verification, accepts username login, and never sends passwords or recovery keys', async () => {
    const client = h.client();
    const prepared = await client.prepareRegistration(
      { email: 'alice@example.test', username: 'ALICE', displayName: 'Alice' },
      password,
    );
    await client.register(prepared);
    await expect(client.login('alice', password)).rejects.toThrow('Verify your email');
    const verification = h.mail[0].token;
    await h.transport('/verify-email', { token: verification });
    await client.login('ALICE', password);
    expect(client.unlocked).toBeDefined();
    expect(client.account?.username).toBe('alice');
    expect(h.requests.join('')).not.toContain(password);
    expect(h.requests.join('')).not.toContain(prepared.recoveryKey);
    await expect(h.transport('/verify-email', { token: verification })).rejects.toThrow();
    const rows = await h.database.query<{ bundle: unknown }>(
      'SELECT bundle FROM ultra_accounts',
    );
    expect(JSON.stringify(rows.rows)).not.toContain(prepared.recoveryKey);
    expect(JSON.stringify(rows.rows)).not.toContain(client.unlocked!.masterKey);
    const caps = await h.client().init();
    expect(caps.features.scopedSync).toBe(true);
    expect(caps.features.sharedProjects).toBe(true);
  });
  it('rejects wrong passwords, unknown users, replayed challenges, and legacy bearer tokens', async () => {
    const registered = await h.register();
    await expect(h.client().login('alice', 'an incorrect password')).rejects.toThrow();
    await expect(h.client().login('missing@example.test', password)).rejects.toThrow();
    await expect(h.transport('/me', undefined, randomKey())).rejects.toThrow();
    await expect(h.transport('/me', undefined, registered.verifyToken)).rejects.toThrow();
    await expect(
      h.transport('/login/finish', {
        loginToken: registered.verifyToken,
        finishLoginRequest: 'a'.repeat(64),
      }),
    ).rejects.toThrow();
    const result = await h.app.inject({
      method: 'POST',
      url: '/api/v2/accounts/register/start',
      payload: {
        email: 'x@example.test',
        registrationRequest: 'x'.repeat(64),
        password: 'must never be accepted',
      },
    });
    expect(result.statusCode).toBe(400);
    const sent = h.requests
      .map((request) => JSON.parse(request))
      .find((request) => request.finishLoginRequest);
    await expect(h.transport('/login/finish', sent)).rejects.toThrow();
  });

  it('replaces unverified enrollment without allowing its stale email link to activate different keys', async () => {
    const first = h.client();
    const prepared = await first.prepareRegistration(
      { email: 'pending@example.test', displayName: 'First' },
      password,
    );
    await first.register(prepared);
    const stale = h.mail[0].token;
    const second = h.client();
    const replacement = await second.prepareRegistration(
      { email: 'pending@example.test', displayName: 'Second' },
      'a different pending password',
    );
    await second.register(replacement);
    await expect(h.transport('/verify-email', { token: stale })).rejects.toThrow();
    await h.transport('/verify-email', { token: h.mail.at(-1)!.token });
    await second.login('pending@example.test', 'a different pending password');
    expect(second.unlocked!.masterKey).toBe(
      (
        await unlockBundle(replacement.request.bundle, second.identity(), {
          recoveryKey: replacement.recoveryKey,
        })
      ).masterKey,
    );
    await expect(first.login('pending@example.test', password)).rejects.toThrow();
  });
  it('verifies a TOTP before enabling it, requires 2FA, and rejects reused codes', async () => {
    const { client } = await h.register();
    const other = h.client();
    await other.login('alice', password);
    const enrollment = await client.request<{ enrollmentToken: string; secret: string }>(
      '/factors/totp/start',
      {},
    );
    await expect(
      client.request('/factors/totp/finish', {
        enrollmentToken: enrollment.enrollmentToken,
        code: 'invalid',
      }),
    ).rejects.toThrow();
    const codes = await client.request<{ recoveryCodes: string[] }>(
      '/factors/totp/finish',
      { enrollmentToken: enrollment.enrollmentToken, code: totp(enrollment.secret) },
    );
    expect(codes.recoveryCodes).toHaveLength(10);
    await expect(other.request('/me')).rejects.toThrow();
    const login = h.client();
    const pending = await login.login('alice', password);
    expect(pending.accessToken).toBeUndefined();
    expect(login.bundle).toBeUndefined();
    await expect(h.transport('/me', undefined, pending.mfaToken)).rejects.toThrow();
    await login.completeMfa(totp(enrollment.secret, Math.floor(Date.now() / 30000) + 1));
    expect(login.unlocked).toBeDefined();
    const replay = h.client();
    await replay.login('alice', password);
    await expect(
      replay.completeMfa(totp(enrollment.secret, Math.floor(Date.now() / 30000) + 1)),
    ).rejects.toThrow();
    await replay.completeMfa(codes.recoveryCodes[0]);
    const reuse = h.client();
    await reuse.login('alice', password);
    await expect(reuse.completeMfa(codes.recoveryCodes[0])).rejects.toThrow();
    const stored = JSON.stringify(
      (await h.database.query('SELECT data FROM ultra_factors')).rows,
    );
    expect(stored).not.toContain(enrollment.secret);
    expect(
      JSON.stringify(
        (await h.database.query('SELECT digest FROM ultra_recovery_codes')).rows,
      ),
    ).not.toContain(codes.recoveryCodes[1]);
  });
  it('rewraps the vault atomically on password change, preserves the recovery key, and revokes other sessions', async () => {
    const { client, prepared } = await h.register();
    const second = h.client();
    await second.login('alice', password);
    const masterKey = client.unlocked!.masterKey;
    const ciphertext = client.bundle!.vault;
    await client.changePassword('a replacement account password');
    expect(client.bundle!.vault).toEqual(ciphertext);
    expect(
      (
        await unlockBundle(client.bundle!, client.identity(), {
          recoveryKey: prepared.recoveryKey,
        })
      ).masterKey,
    ).toBe(masterKey);
    await expect(second.request('/me')).rejects.toThrow();
    await expect(h.client().login('alice', password)).rejects.toThrow();
    const fresh = h.client();
    await fresh.login('alice', 'a replacement account password');
    expect(fresh.unlocked!.masterKey).toBe(masterKey);
    const row = await h.database.query<{ vault_version: number }>(
      'SELECT vault_version FROM ultra_accounts',
    );
    expect(row.rows[0].vault_version).toBe(2);
  });

  it('invalidates pending email changes when password recovery takes account control back', async () => {
    const { client, prepared } = await h.register();
    await client.request(
      '/profile',
      { username: 'alice', displayName: 'Alice', email: 'pending-new@example.test' },
      'PUT',
    );
    const stale = h.mail.findLast(
      (message) => message.email === 'pending-new@example.test',
    )!.token;
    await h.transport('/recovery/request', { identifier: 'alice' });
    const mailToken = h.mail.findLast((message) => message.kind === 'recover')!.token;
    await h
      .client()
      .recover(
        mailToken,
        prepared.recoveryKey,
        'the recovered original account password',
      );
    await expect(h.transport('/verify-email', { token: stale })).rejects.toThrow();
    const login = h.client();
    await login.login('alice@example.test', 'the recovered original account password');
    expect(login.account!.email).toBe('alice@example.test');
  });
  it('requires both email recovery proof and the recovery key; preserves data and consumes the link once', async () => {
    const { client, prepared } = await h.register();
    const masterKey = client.unlocked!.masterKey;
    await h.transport('/recovery/request', { identifier: 'alice' });
    const mailToken = h.mail.findLast((message) => message.kind === 'recover')!.token;
    const recovery = h.client();
    await expect(
      recovery.recover(
        mailToken,
        'UTRK1-' + '00'.repeat(32),
        'my recovered account password',
      ),
    ).rejects.toThrow();
    await recovery.recover(
      mailToken,
      prepared.recoveryKey,
      'my recovered account password',
    );
    await expect(client.request('/me')).rejects.toThrow();
    await expect(h.client().login('alice', password)).rejects.toThrow();
    const fresh = h.client();
    await fresh.login('alice', 'my recovered account password');
    expect(fresh.unlocked!.masterKey).toBe(masterKey);
    await expect(
      recovery.recover(mailToken, prepared.recoveryKey, 'another recovered password'),
    ).rejects.toThrow();
    expect(h.requests.join('')).not.toContain(prepared.recoveryKey);
  });
  it('cannot bypass MFA through account recovery', async () => {
    const { client, prepared } = await h.register();
    const enrollment = await client.request<{ enrollmentToken: string; secret: string }>(
      '/factors/totp/start',
      {},
    );
    const codes = await client.request<{ recoveryCodes: string[] }>(
      '/factors/totp/finish',
      { enrollmentToken: enrollment.enrollmentToken, code: totp(enrollment.secret) },
    );
    await h.transport('/recovery/request', { identifier: 'alice' });
    const mailToken = h.mail.findLast((message) => message.kind === 'recover')!.token;
    const recovery = h.client();
    await expect(
      recovery.recover(mailToken, prepared.recoveryKey, 'replacement password for mfa'),
    ).rejects.toThrow('authenticator');
    await recovery.recover(
      mailToken,
      prepared.recoveryKey,
      'replacement password for mfa',
      codes.recoveryCodes[0],
    );
    const pending = await h.client().login('alice', 'replacement password for mfa');
    expect(pending.mfaToken).toBeDefined();
    expect(pending.accessToken).toBeUndefined();
  });
  it('rotates refresh tokens, detects reuse, and revokes only the affected device', async () => {
    const { client } = await h.register();
    const second = h.client();
    await second.login('alice', password);
    const refreshToken = client.tokens!.refreshToken;
    const rotated = (await h.transport('/sessions/refresh', { refreshToken })) as {
      accessToken: string;
      refreshToken: string;
    };
    expect(rotated.refreshToken).not.toBe(refreshToken);
    await expect(h.transport('/sessions/refresh', { refreshToken })).rejects.toThrow();
    await expect(h.transport('/me', undefined, rotated.accessToken)).rejects.toThrow();
    expect(await second.request('/me')).toBeDefined();
    expect(
      JSON.stringify((await h.database.query('SELECT * FROM ultra_refresh_tokens')).rows),
    ).not.toContain(rotated.refreshToken);
    expect(
      (
        await h.database.query(
          'SELECT digest FROM ultra_refresh_tokens WHERE digest=$1',
          [digest(rotated.refreshToken)],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('keeps account IDs and decryption stable through profile changes and isolates device revocation', async () => {
    const alice = (await h.register()).client;
    const bob = (await h.register('bob@example.test', 'bobby')).client;
    const id = alice.account!.id;
    await alice.request(
      '/profile',
      { username: 'alice_new', displayName: 'Alice new', email: 'new@example.test' },
      'PUT',
    );
    const verification = h.mail.findLast(
      (message) => message.email === 'new@example.test',
    )!.token;
    await h.transport('/verify-email', { token: verification });
    const fresh = h.client();
    await fresh.login('new@example.test', password);
    expect(fresh.account!.id).toBe(id);
    expect(fresh.unlocked!.masterKey).toBe(alice.unlocked!.masterKey);
    const sessions = await bob.request<{ id: string }[]>('/sessions');
    await alice.request('/sessions/revoke', { sessionId: sessions[0].id });
    expect(await bob.request('/me')).toBeDefined();
    await h.db.$executeRaw(
      Prisma.sql`UPDATE ultra_sessions SET expires_at=0 WHERE account_id=${id}`,
    );
    await expect(fresh.request('/me')).rejects.toThrow();
  });
  it('rejects malformed KDFs/private public keys and rate limits recovery requests', async () => {
    const client = h.client();
    const prepared = await client.prepareRegistration(
      { email: 'reject@example.test', displayName: 'Reject' },
      password,
    );
    const result = await h.app.inject({
      method: 'POST',
      url: '/api/v2/accounts/register/finish',
      payload: {
        ...prepared.request,
        bundle: {
          ...prepared.request.bundle,
          kdf: { ...prepared.request.bundle.kdf, memory: 8 },
        },
      },
    });
    expect(result.statusCode).toBe(400);
    const privateKey = await h.app.inject({
      method: 'POST',
      url: '/api/v2/accounts/register/finish',
      payload: {
        ...prepared.request,
        bundle: {
          ...prepared.request.bundle,
          signingPublicKey: { ...prepared.request.bundle.signingPublicKey, d: 'secret' },
        },
      },
    });
    expect(privateKey.statusCode).toBe(400);
    for (let i = 0; i < 5; i++)
      await h.transport('/recovery/request', { identifier: 'missing@example.test' });
    await expect(
      h.transport('/recovery/request', { identifier: 'missing@example.test' }),
    ).rejects.toThrow();
    expect(totpStep('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'not-a-code')).toBeUndefined();
  });
});
