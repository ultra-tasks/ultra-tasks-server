import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { approveBrowserLogin } from '@ultra-tasks/account-crypto';
import { createHarness, password } from './ultra-account.helper';
import { decodePrivate, digest, totp } from '../src/ultra-account/security';
import type { DeviceChallengeData } from '../src/ultra-account/device-store';

// Production-strength Argon2/OPAQUE can exceed the default 5s under parallel suite load.
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

type Harness = Awaited<ReturnType<typeof createHarness>>;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const WRONG = 'Invalid or expired verification code';

/** Helpers bound to one harness. A test that needs time travel freezes the clock itself. */
const toolkit = (h: Harness) => {
  const deviceMail = (email: string) =>
    h.mail.filter((message) => message.email === email && message.kind === 'device');
  const lastCode = (email: string) => deviceMail(email).at(-1)!.token;
  const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await h.database.query<T>(sql, params)).rows;
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await rows<{ n: number }>(sql, params))[0].n);
  const pending = (accountId: string) =>
    count(
      "SELECT count(*) AS n FROM ultra_challenges WHERE kind='device-email' AND account_id=$1",
      [accountId],
    );
  const signIn = async (email: string, deviceToken?: string, name = 'Test device') => {
    const client = h.client();
    const result = await client.login(
      email,
      password,
      name,
      deviceToken ? { deviceToken } : {},
    );
    return { client, result };
  };
  /** A complete sign-in on an unrecognised device: challenge, emailed code, session. */
  const addDevice = async (email: string, name = 'Another device') => {
    const { client, result } = await signIn(email, undefined, name);
    expect(result.verification).toBeDefined();
    await client.completeDeviceVerification(lastCode(email));
    return client;
  };
  const freeze = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
  };
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const verify = (token: string, code: string) =>
    h.transport('/login/device/verify', { token, code });
  const resend = (token: string) => h.transport('/login/device/resend', { token });
  const otherThan = (code: string) => (code === '00000000' ? '00000001' : '00000000');
  const insertSessions = async (accountId: string, total: number) => {
    const now = Date.now();
    for (let i = 0; i < total; i++)
      await h.db.$executeRaw(
        Prisma.sql`INSERT INTO ultra_sessions(id,account_id,device_name,created_at,auth_at,expires_at,idle_expires_at) VALUES (${crypto.randomUUID()},${accountId},${'Extra ' + i},${BigInt(now)},${BigInt(now)},${BigInt(now + 90 * 86400000)},${BigInt(now + 30 * 86400000)})`,
      );
  };
  const enrollTotp = async (client: Awaited<ReturnType<typeof addDevice>>) => {
    const enrollment = await client.request<{ enrollmentToken: string; secret: string }>(
      '/factors/totp/start',
      {},
    );
    const finished = await client.request<{ recoveryCodes: string[] }>(
      '/factors/totp/finish',
      { enrollmentToken: enrollment.enrollmentToken, code: totp(enrollment.secret) },
    );
    return finished.recoveryCodes;
  };
  return {
    deviceMail,
    lastCode,
    rows,
    count,
    pending,
    signIn,
    addDevice,
    freeze,
    advance,
    verify,
    resend,
    otherThan,
    insertSessions,
    enrollTotp,
  };
};

describe.each(['native', 'better-auth'] as const)(
  'new-device email verification core flow with %s sessions',
  (authEngine) => {
    let h: Harness;
    let t: ReturnType<typeof toolkit>;
    beforeAll(async () => {
      h = await createHarness({
        authEngine,
        privateOnly: true,
        deviceEmailVerification: true,
        disableRateLimit: true,
      });
      t = toolkit(h);
    });
    afterEach(() => {
      vi.useRealTimers();
      h.failingMail.clear();
    });
    afterAll(async () => h.close());

    it('advertises the feature, challenges an unrecognised device and issues nothing until the code is accepted', async () => {
      const email = 'core@example.test';
      expect((await h.client().init()).features).toMatchObject({
        newDeviceEmailVerification: true,
        trustedDevices: true,
        sessionLifetime: 'sliding-v1',
      });
      // A new account's first sign-in is itself an unrecognised device; register() completes it.
      const { client: first } = await h.register(email, 'core');
      expect(t.deviceMail(email)).toHaveLength(1);
      expect(first.deviceToken).toMatch(TOKEN);
      expect(await first.getSecuritySettings()).toEqual({
        newDeviceEmailVerification: true,
        available: true,
      });

      const { client, result } = await t.signIn(email, undefined, 'Windows desktop');
      expect(result.accessToken).toBeUndefined();
      expect(result.refreshToken).toBeUndefined();
      expect(result.verification).toMatchObject({
        kind: 'email',
        expiresIn: 600,
        resendAfter: 30,
        resendsLeft: 3,
        emailHint: 'c***@example.test',
      });
      expect(client.unlocked).toBeUndefined();
      expect(client.bundle).toBeUndefined();
      // The challenge handle is not a credential for any account route.
      await expect(
        h.transport('/me', undefined, result.verification!.token),
      ).rejects.toMatchObject({ status: 401 });
      expect(t.deviceMail(email)).toHaveLength(2);
      const code = t.lastCode(email);
      expect(code).toMatch(/^\d{8}$/);

      // At rest: only digests and an HMAC. The code, the handle and the hint's address are absent.
      const stored = await t.rows<{ digest: string; account_id: string; data: unknown }>(
        "SELECT digest,account_id,data FROM ultra_challenges WHERE kind='device-email'",
      );
      const row = stored.find(
        (entry) => entry.digest === digest(result.verification!.token),
      )!;
      expect(row.account_id).toBe(first.account!.id);
      expect(JSON.stringify(stored)).not.toContain(code);
      expect(JSON.stringify(stored)).not.toContain(result.verification!.token);
      const data = await decodePrivate<DeviceChallengeData>(
        h.config,
        row.digest,
        row.data,
      );
      expect(data).toMatchObject({ deviceName: 'Windows desktop', resends: 0 });
      expect(data.codeHmac).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(data)).not.toContain(code);

      await client.completeDeviceVerification(code);
      expect(client.unlocked).toBeDefined();
      expect(client.deviceToken).toMatch(TOKEN);
      expect(client.deviceToken).not.toBe(first.deviceToken);
      // The device record stores only a digest of its token.
      const devices = await t.rows<{ token_digest: string; label: string }>(
        'SELECT token_digest,label FROM ultra_devices WHERE account_id=$1',
        [first.account!.id],
      );
      expect(devices.map((device) => device.token_digest)).toContain(
        digest(client.deviceToken!),
      );
      expect(JSON.stringify(devices)).not.toContain(client.deviceToken!);
      expect(devices.map((device) => device.label)).toContain('Windows desktop');
      await expect(t.verify(result.verification!.token, code)).rejects.toMatchObject({
        status: 401,
        message: WRONG,
      });
      expect(await t.pending(first.account!.id)).toBe(0);
    });

    it('recognises a returning device without an email, lists devices and marks sessions trusted', async () => {
      const email = 'returning@example.test';
      const { client: first } = await h.register(email, 'returning');
      const before = t.deviceMail(email).length;
      const { client, result } = await t.signIn(email, first.deviceToken);
      expect(result.verification).toBeUndefined();
      expect(result.deviceToken).toBeUndefined();
      expect(client.deviceToken).toBe(first.deviceToken);
      expect(client.unlocked).toBeDefined();
      expect(t.deviceMail(email)).toHaveLength(before);

      const devices = await client.devices();
      expect(devices).toHaveLength(1);
      // A recognised sign-in under another name must not rename the trusted device.
      expect(devices[0]).toMatchObject({
        label: 'This device',
        current: true,
        sessions: 2,
      });
      expect(devices[0].lastSeenAt).toBeGreaterThanOrEqual(devices[0].createdAt);
      const sessions = await client.request<
        {
          current: boolean;
          trusted: boolean;
          deviceId: string | null;
          lastSeenAt: number;
          createdAt: number;
        }[]
      >('/sessions');
      expect(sessions).toHaveLength(2);
      for (const row of sessions) {
        expect(row.trusted).toBe(true);
        expect(row.deviceId).toBe(devices[0].id);
        expect(row.lastSeenAt).toBeGreaterThanOrEqual(row.createdAt);
      }
      // A device that holds no token is a new device again.
      expect((await t.signIn(email)).result.verification).toBeDefined();
    });

    it('ends a revoked device, its sessions and its trust, and cannot reach another account', async () => {
      const email = 'revoke@example.test';
      const { client: a } = await h.register(email, 'revoke');
      const b = await t.addDevice(email, 'Second device');
      const devices = await a.devices();
      expect(devices).toHaveLength(2);
      const second = devices.find((device) => !device.current)!;
      expect(second.label).toBe('Second device');

      const other = await h.register('revoke-other@example.test', 'revokeother');
      const otherDevice = (await other.client.devices())[0];
      await a.revokeDevice(otherDevice.id);
      expect(await other.client.devices()).toHaveLength(1);
      expect(await other.client.request('/me')).toBeDefined();

      await a.revokeDevice(second.id);
      await expect(b.request('/me')).rejects.toMatchObject({ status: 401 });
      expect(await a.devices()).toHaveLength(1);
      const { result } = await t.signIn(email, b.deviceToken);
      expect(result.verification).toBeDefined();
      const sessions = await a.request<
        {
          deviceName: string;
          trusted: boolean;
          revoked: boolean;
          deviceId: string | null;
        }[]
      >('/sessions');
      expect(sessions.find((row) => row.deviceName === 'Second device')).toMatchObject({
        revoked: true,
        trusted: false,
        deviceId: null,
      });
      // Nothing about a removed device is retained: its record is gone, not flagged.
      expect(
        await t.count('SELECT count(*) AS n FROM ultra_devices WHERE id=$1', [second.id]),
      ).toBe(0);
    });

    it('lets a trusted browser approve an app sign-in without a second email, and refuses an untrusted approver', async () => {
      const email = 'approve@example.test';
      const { client: browser } = await h.register(email, 'approve');
      const before = t.deviceMail(email).length;
      const app = h.client();
      const flow = await app.startBrowserLogin(
        h.config.publicUrl,
        'app.ultratasks://account-login',
        'My phone',
      );
      await approveBrowserLogin(browser, flow.request);
      expect(await app.pollBrowserLogin()).toBe(true);
      expect(app.deviceToken).toMatch(TOKEN);
      expect(t.deviceMail(email)).toHaveLength(before);
      const sessions =
        await browser.request<{ deviceName: string; trusted: boolean }[]>('/sessions');
      expect(sessions.find((row) => row.deviceName === 'My phone')).toMatchObject({
        trusted: true,
      });
      // The app is now a recognised device: its next password sign-in sends no email.
      const again = await t.signIn(email, app.deviceToken);
      expect(again.result.verification).toBeUndefined();
      expect(t.deviceMail(email)).toHaveLength(before);

      // A session that never passed the policy (issued before the feature) cannot vouch for
      // another device: the person signs in again on that browser first.
      await h.database.query(
        'UPDATE ultra_sessions SET device_id=NULL WHERE account_id=$1',
        [browser.account!.id],
      );
      const next = h.client();
      const second = await next.startBrowserLogin(
        h.config.publicUrl,
        'app.ultratasks://account-login',
        'Tablet',
      );
      await expect(approveBrowserLogin(browser, second.request)).rejects.toMatchObject({
        status: 403,
        code: 'device_verification_required',
      });
      await expect(next.pollBrowserLogin()).resolves.toBe(false);
    });

    it('never replaces or adds to a second factor, and records the device once the factor passes', async () => {
      const email = 'factor@example.test';
      const { client } = await h.register(email, 'factor');
      const codes = await t.enrollTotp(client);
      const before = t.deviceMail(email).length;

      const login = h.client();
      const pending = await login.login(email, password, 'Phone');
      expect(pending.mfaToken).toBeDefined();
      expect(pending.verification).toBeUndefined();
      expect(login.deviceToken).toBeUndefined();
      expect(t.deviceMail(email)).toHaveLength(before);
      await login.completeMfa(codes[0]);
      expect(login.deviceToken).toMatch(TOKEN);

      // Removing the factor falls back to the email policy: known device passes, unknown is asked.
      const me = await client.request<{ factors: { id: string }[] }>('/me');
      await client.request('/factors/remove', {
        factorId: me.factors[0].id,
        code: codes[1],
      });
      expect(
        (await t.signIn(email, login.deviceToken)).result.verification,
      ).toBeUndefined();
      expect((await t.signIn(email)).result.verification).toBeDefined();
    });
  },
);

describe('new-device email verification: limits, account changes and failure handling', () => {
  let h: Harness;
  let t: ReturnType<typeof toolkit>;
  beforeAll(async () => {
    // The engine follows ULTRA_TEST_AUTH_ENGINE, so the whole suite also runs on Better Auth.
    h = await createHarness({
      privateOnly: true,
      deviceEmailVerification: true,
      disableRateLimit: true,
    });
    t = toolkit(h);
  });
  afterEach(() => {
    vi.useRealTimers();
    h.failingMail.clear();
  });
  afterAll(async () => h.close());

  it('locks after five wrong codes, even for the right one, and a resend never resets the attempt budget', async () => {
    const email = 'attempts@example.test';
    await h.register(email, 'attempts');
    const { result } = await t.signIn(email);
    const token = result.verification!.token;
    const wrong = t.otherThan(t.lastCode(email));
    for (let i = 0; i < 2; i++)
      await expect(t.verify(token, wrong)).rejects.toMatchObject({
        status: 401,
        message: WRONG,
      });
    t.freeze();
    t.advance(31000);
    await t.resend(token);
    const replacement = t.lastCode(email);
    const bad = t.otherThan(replacement);
    expect(
      await t.count('SELECT attempts AS n FROM ultra_challenges WHERE digest=$1', [
        digest(token),
      ]),
    ).toBe(2);
    for (let i = 0; i < 3; i++)
      await expect(t.verify(token, bad)).rejects.toMatchObject({ status: 401 });
    // Five failures in total across the resend: the correct code no longer works.
    await expect(t.verify(token, replacement)).rejects.toMatchObject({ status: 401 });
    t.advance(31000);
    await expect(t.resend(token)).rejects.toMatchObject({ status: 401 });
    expect((await t.signIn(email)).result.verification).toBeDefined();
  });

  it('enforces the resend cooldown and cap, replaces the code in the same challenge and keeps its expiry', async () => {
    const email = 'resend@example.test';
    await h.register(email, 'resend');
    const { client, result } = await t.signIn(email);
    const token = result.verification!.token;
    const first = t.lastCode(email);
    const expiry = () =>
      t.rows<{ expires_at: number }>(
        'SELECT expires_at FROM ultra_challenges WHERE digest=$1',
        [digest(token)],
      );
    const initial = await expiry();
    await expect(t.resend(token)).rejects.toMatchObject({
      status: 429,
      code: 'resend_too_soon',
    });
    expect(t.deviceMail(email).filter((m) => m.token === first)).toHaveLength(1);
    t.freeze();
    for (let sent = 1; sent <= 3; sent++) {
      t.advance(31000);
      const again = await client.resendDeviceVerification();
      expect(again).toMatchObject({ token, resendsLeft: 3 - sent, resendAfter: 30 });
      expect(client.pendingDeviceVerification).toEqual(again);
      await expect(t.resend(token)).rejects.toMatchObject({
        status: 429,
        code: sent < 3 ? 'resend_too_soon' : 'resend_limit',
      });
    }
    t.advance(31000);
    await expect(t.resend(token)).rejects.toMatchObject({
      status: 429,
      code: 'resend_limit',
    });
    expect(await expiry()).toEqual(initial);
    // Only the newest code works; the first is gone and its attempt was counted.
    const latest = t.lastCode(email);
    expect(t.deviceMail(email)).toHaveLength(5);
    await expect(t.verify(token, first)).rejects.toMatchObject({ status: 401 });
    await expect(t.verify(token, t.otherThan(latest))).rejects.toMatchObject({
      status: 401,
    });
    await client.completeDeviceVerification(latest);
    expect(client.unlocked).toBeDefined();
  });

  it('rejects an expired code and a resend after expiry', async () => {
    const email = 'expired@example.test';
    await h.register(email, 'expired');
    const { result } = await t.signIn(email);
    const token = result.verification!.token;
    const code = t.lastCode(email);
    t.freeze();
    t.advance(10 * 60 * 1000 + 1000);
    await expect(t.verify(token, code)).rejects.toMatchObject({
      status: 401,
      message: WRONG,
    });
    await expect(t.resend(token)).rejects.toMatchObject({ status: 401 });
  });

  it("does not accept another account's code or token, nor recognise another account's device", async () => {
    const aliceEmail = 'cross-a@example.test';
    const bobEmail = 'cross-b@example.test';
    const { client: alice } = await h.register(aliceEmail, 'crossa');
    await h.register(bobEmail, 'crossb');
    const forAlice = await t.signIn(aliceEmail);
    const forBob = await t.signIn(bobEmail);
    const aliceCode = t.lastCode(aliceEmail);
    const bobCode = t.lastCode(bobEmail);
    await expect(
      t.verify(forBob.result.verification!.token, aliceCode),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      t.verify(forAlice.result.verification!.token, bobCode),
    ).rejects.toMatchObject({ status: 401 });
    // Each challenge is still intact for its own code.
    await forAlice.client.completeDeviceVerification(aliceCode);
    await forBob.client.completeDeviceVerification(bobCode);
    await expect(
      t.verify(forAlice.result.verification!.token, aliceCode),
    ).rejects.toMatchObject({ status: 401 });
    // Alice's device token does not make a device of Bob's recognised.
    const { result } = await t.signIn(bobEmail, alice.deviceToken);
    expect(result.verification).toBeDefined();
  });

  it('lets the owner opt out and back in; turning it back on forgets the devices minted meanwhile but keeps the caller', async () => {
    const email = 'optout@example.test';
    const { client } = await h.register(email, 'optout');
    await client.setNewDeviceEmailVerification(false);
    expect((await client.getSecuritySettings()).newDeviceEmailVerification).toBe(false);
    const before = t.deviceMail(email).length;
    const meanwhile = await t.signIn(email, undefined, 'While opted out');
    expect(meanwhile.result.verification).toBeUndefined();
    expect(meanwhile.client.deviceToken).toMatch(TOKEN);
    expect(t.deviceMail(email)).toHaveLength(before);
    expect(await client.devices()).toHaveLength(2);
    await client.setNewDeviceEmailVerification(true);
    // Trust handed out while a password alone was enough does not survive the opt-back-in...
    expect(await client.devices()).toHaveLength(1);
    expect(
      (await t.signIn(email, meanwhile.client.deviceToken)).result.verification,
    ).toBeDefined();
    // ...yet its session keeps running (unbound), and the caller's own device is untouched.
    expect(await meanwhile.client.request('/me')).toBeDefined();
    const unbound = (
      await client.request<{ deviceName: string; trusted: boolean }[]>('/sessions')
    ).find((row) => row.deviceName === 'While opted out');
    expect(unbound?.trusted).toBe(false);
    expect(
      (await t.signIn(email, client.deviceToken)).result.verification,
    ).toBeUndefined();
    expect((await t.signIn(email)).result.verification).toBeDefined();
  });

  it('needs a recent sign-in to change the setting, and a factor code to turn it off with one enrolled', async () => {
    const stale = await h.register('stale@example.test', 'stale');
    t.freeze();
    t.advance(11 * 60 * 1000);
    await expect(stale.client.setNewDeviceEmailVerification(false)).rejects.toMatchObject(
      {
        status: 403,
      },
    );
    vi.useRealTimers();

    const email = 'strong@example.test';
    const { client } = await h.register(email, 'strong');
    const codes = await t.enrollTotp(client);
    await expect(client.setNewDeviceEmailVerification(false)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      client.setNewDeviceEmailVerification(false, '000000'),
    ).rejects.toMatchObject({
      status: 401,
    });
    await client.setNewDeviceEmailVerification(false, codes[0]);
    expect((await client.getSecuritySettings()).newDeviceEmailVerification).toBe(false);
    // Turning it on is the safe direction and needs no code.
    await client.setNewDeviceEmailVerification(true);
    expect((await client.getSecuritySettings()).newDeviceEmailVerification).toBe(true);
  });

  it('drops a pending challenge when the email address changes', async () => {
    const email = 'moving@example.test';
    const { client } = await h.register(email, 'moving');
    const { result } = await t.signIn(email);
    const code = t.lastCode(email);
    await client.request('/profile', { email: 'moved@example.test' }, 'PUT');
    expect(await t.pending(client.account!.id)).toBe(1);
    const link = h.mail.findLast(
      (message) => message.email === 'moved@example.test',
    )!.token;
    await h.transport('/verify-email', { token: link });
    expect(await t.pending(client.account!.id)).toBe(0);
    await expect(t.verify(result.verification!.token, code)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('on a password change deletes pending challenges and keeps only the current device trusted', async () => {
    const email = 'password@example.test';
    const next = 'a changed password for the device tests';
    const { client: a } = await h.register(email, 'password');
    const b = await t.addDevice(email, 'Second device');
    const { result } = await t.signIn(email);
    const code = t.lastCode(email);
    await a.changePassword(next);
    expect(await t.pending(a.account!.id)).toBe(0);
    await expect(t.verify(result.verification!.token, code)).rejects.toMatchObject({
      status: 401,
    });
    const current = (
      await a.request<{ current: boolean; trusted: boolean }[]>('/sessions')
    ).find((row) => row.current);
    expect(current?.trusted).toBe(true);
    const staying = await h
      .client()
      .login(email, next, 'A', { deviceToken: a.deviceToken });
    expect(staying.verification).toBeUndefined();
    const leaving = await h
      .client()
      .login(email, next, 'B', { deviceToken: b.deviceToken });
    expect(leaving.verification).toBeDefined();
    // The other device's record is deleted, not flagged; the current one remains.
    expect(
      await t.count('SELECT count(*) AS n FROM ultra_devices WHERE account_id=$1', [
        a.account!.id,
      ]),
    ).toBe(1);
  });

  it('on recovery deletes pending challenges and ends every device trust', async () => {
    const email = 'recovery@example.test';
    const reset = 'a recovered password for the device tests';
    const { client, prepared } = await h.register(email, 'recovery');
    const { result } = await t.signIn(email);
    const code = t.lastCode(email);
    await h.transport('/recovery/request', { identifier: email });
    const mailToken = h.mail.findLast((message) => message.kind === 'recover')!.token;
    await h.client().recover(mailToken, prepared.recoveryKey, reset);
    expect(await t.pending(client.account!.id)).toBe(0);
    await expect(t.verify(result.verification!.token, code)).rejects.toMatchObject({
      status: 401,
    });
    const login = await h.client().login(email, reset, 'Same device', {
      deviceToken: client.deviceToken,
    });
    expect(login.verification).toBeDefined();
    // Recovery deletes every device record; nothing is kept for a later sign-in.
    expect(
      await t.count('SELECT count(*) AS n FROM ultra_devices WHERE account_id=$1', [
        client.account!.id,
      ]),
    ).toBe(0);
  });

  it('answers 503 and issues nothing when mail cannot be delivered, on sign-in and on resend', async () => {
    const email = 'smtp@example.test';
    const { client } = await h.register(email, 'smtp');
    const sessions = () =>
      t.count('SELECT count(*) AS n FROM ultra_sessions WHERE account_id=$1', [
        client.account!.id,
      ]);
    const before = await sessions();
    h.failingMail.add('device');
    const failed = h.client();
    await expect(failed.login(email, password, 'Phone')).rejects.toMatchObject({
      status: 503,
      code: 'email_delivery_failed',
    });
    expect(failed.tokens).toBeUndefined();
    expect(await t.pending(client.account!.id)).toBe(0);
    expect(await sessions()).toBe(before);
    // The legacy path gets the same clear refusal while mail is down, never a bypass.
    await expect(h.legacyLogin(email)).rejects.toMatchObject({ status: 426 });

    h.failingMail.clear();
    const { client: retry } = await t.signIn(email);
    expect(await t.pending(client.account!.id)).toBe(1);
    t.freeze();
    t.advance(31000);
    h.failingMail.add('device');
    await expect(retry.resendDeviceVerification()).rejects.toMatchObject({
      status: 503,
      code: 'email_delivery_failed',
    });
    expect(await t.pending(client.account!.id)).toBe(0);
    expect(await sessions()).toBe(before);
  });

  it('keeps at most 30 devices, pruning the least recently active first', async () => {
    const email = 'devices@example.test';
    const { client } = await h.register(email, 'devices');
    const accountId = client.account!.id;
    // Seeds are recent enough to be inside the idle window, and strictly ordered by activity.
    const base = Date.now() - 100 * 86400000;
    for (let i = 0; i < 29; i++)
      await h.db.$executeRaw(
        Prisma.sql`INSERT INTO ultra_devices(id,account_id,token_digest,label,created_at,last_seen_at) VALUES (${crypto.randomUUID()},${accountId},${digest('seed-' + i)},${'Seed ' + i},${BigInt(base + i)},${BigInt(base + i)})`,
      );
    const labels = async () =>
      (
        await t.rows<{ label: string }>(
          'SELECT label FROM ultra_devices WHERE account_id=$1',
          [accountId],
        )
      ).map((row) => row.label);
    expect(await labels()).toHaveLength(30);
    await t.addDevice(email, 'Newest');
    let kept = await labels();
    expect(kept).toHaveLength(30);
    expect(kept).not.toContain('Seed 0');
    expect(kept).toContain('Seed 1');
    expect(kept).toContain('Newest');
    await t.addDevice(email, 'Newer');
    kept = await labels();
    expect(kept).toHaveLength(30);
    expect(kept).not.toContain('Seed 1');
    expect(kept).toContain('Seed 2');
    expect(kept).toEqual(expect.arrayContaining(['Newest', 'Newer', 'This device']));
  });

  it('bounds the emails sent to one account per hour, counting resends, and recovers when the window passes', async () => {
    const email = 'budget@example.test';
    const declare = { clientFeatures: ['deviceEmail'] };
    const { client: first } = await h.register(email, 'budget');
    // register() spent the first email (its own first device); eleven more reach the limit of 12.
    let challenge = '';
    for (let i = 0; i < 11; i++) {
      const body = (await h.legacyLogin(email, password, declare)) as {
        verification: { token: string };
      };
      expect(body.verification.token).toMatch(TOKEN);
      challenge = body.verification.token;
    }
    expect(t.deviceMail(email)).toHaveLength(12);
    const refusal = { status: 429, code: 'verification_rate_limited' };
    await expect(h.legacyLogin(email, password, declare)).rejects.toMatchObject(refusal);
    // A resend is an email too, even when its own 30 second cooldown has passed.
    t.freeze();
    t.advance(31000);
    await expect(t.resend(challenge)).rejects.toMatchObject(refusal);
    expect(t.deviceMail(email)).toHaveLength(12);
    // A recognised device needs no email, so an exhausted budget does not touch it.
    expect(
      (await t.signIn(email, first.deviceToken)).result.verification,
    ).toBeUndefined();
    t.advance(61 * 60 * 1000);
    const again = (await h.legacyLogin(email, password, declare)) as {
      verification: { token: string };
    };
    expect(again.verification.token).toMatch(TOKEN);
    expect(t.deviceMail(email)).toHaveLength(13);
  });

  it('judges a device by recent activity: a refreshing session keeps its trust, an unused device loses it after the idle window', async () => {
    const email = 'trust@example.test';
    const day = 86400000;
    const { client: active } = await h.register(email, 'trust');
    const unused = await t.addDevice(email, 'Unused device');
    t.freeze();
    for (let i = 0; i < 4; i++) {
      t.advance(60 * day);
      await active.request('/me');
    }
    // 240 days on: the active device refreshed all along, the other has not been seen since.
    expect(
      (await t.signIn(email, active.deviceToken)).result.verification,
    ).toBeUndefined();
    // That sign-in also purged the lapsed record: its token is unknown now, not merely expired.
    expect(
      await t.count('SELECT count(*) AS n FROM ultra_devices WHERE account_id=$1', [
        active.account!.id,
      ]),
    ).toBe(1);
    expect((await t.signIn(email, unused.deviceToken)).result.verification).toBeDefined();
    expect(await active.devices()).toHaveLength(1);
  });

  it('keeps stale sessions until a sign-in is actually issued: a password alone never ends a session', async () => {
    const email = 'stale-cap@example.test';
    const { client } = await h.register(email, 'stalecap');
    const accountId = client.account!.id;
    const old = Date.now() - 5 * 86400000;
    for (let i = 0; i < 29; i++)
      await h.db.$executeRaw(
        Prisma.sql`INSERT INTO ultra_sessions(id,account_id,device_name,created_at,auth_at,expires_at,idle_expires_at) VALUES (${crypto.randomUUID()},${accountId},${'Orphan ' + i},${BigInt(old + i)},${BigInt(old + i)},${BigInt(old + 90 * 86400000)},${BigInt(Date.now() + 30 * 86400000)})`,
      );
    const revoked = () =>
      t.count(
        'SELECT count(*) AS n FROM ultra_sessions WHERE account_id=$1 AND revoked=true',
        [accountId],
      );
    // At the cap with stale orphans: the challenge is created (room can be made) but nothing ends.
    const { client: phone, result } = await t.signIn(email, undefined, 'Phone');
    expect(result.verification).toBeDefined();
    expect(await revoked()).toBe(0);
    // Only once the code is accepted is the oldest orphan retired to make room.
    await phone.completeDeviceVerification(t.lastCode(email));
    expect(phone.unlocked).toBeDefined();
    expect(await revoked()).toBe(1);
    expect(
      await t.count(
        "SELECT count(*) AS n FROM ultra_sessions WHERE account_id=$1 AND revoked=true AND device_name='Orphan 0'",
        [accountId],
      ),
    ).toBe(1);
  });

  it('answers a full session list the same way whatever code is sent, and counts no attempt', async () => {
    const email = 'cap-verify@example.test';
    const { client } = await h.register(email, 'capverify');
    const { result } = await t.signIn(email);
    const token = result.verification!.token;
    const right = t.lastCode(email);
    await t.insertSessions(client.account!.id, 29);
    for (const code of [right, t.otherThan(right)])
      await expect(t.verify(token, code)).rejects.toMatchObject({
        status: 409,
        code: 'session_limit',
      });
    expect(
      await t.count('SELECT attempts AS n FROM ultra_challenges WHERE digest=$1', [
        digest(token),
      ]),
    ).toBe(0);
    await h.db.$executeRaw(
      Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE account_id=${client.account!.id} AND device_name='Extra 0'`,
    );
    await expect(t.verify(token, right)).resolves.toHaveProperty('deviceToken');
  });

  it('refuses a sign-in at the live-session limit before any code is emailed', async () => {
    const email = 'limit@example.test';
    const { client } = await h.register(email, 'limit');
    await t.insertSessions(client.account!.id, 29);
    const before = t.deviceMail(email).length;
    await expect(h.client().login(email, password, 'One too many')).rejects.toMatchObject(
      {
        status: 409,
        code: 'session_limit',
      },
    );
    expect(t.deviceMail(email)).toHaveLength(before);
    expect(await t.pending(client.account!.id)).toBe(0);
  });

  it('reports activity from refreshes without writing device rows, cleans the label of a new device and never renames a recognised one', async () => {
    const email = 'lastseen@example.test';
    const { client } = await h.register(email, 'lastseen');
    // A recognised sign-in under any other name leaves the label alone.
    const again = await t.signIn(email, client.deviceToken, 'Renamed attempt');
    expect(again.result.verification).toBeUndefined();
    const own = () => client.devices().then((list) => list.find((row) => row.current)!);
    const before = await own();
    expect(before.label).toBe('This device');
    // A new device with a hostile name: control and bidirectional characters never reach the list.
    await t.addDevice(email, 'Evil\u202e name\u0007\n  here');
    expect((await client.devices()).map((row) => row.label)).toContain('Evil name here');
    const stored = await t.rows<{ last_seen_at: number }>(
      'SELECT last_seen_at FROM ultra_devices WHERE id=$1',
      [before.id],
    );
    t.freeze();
    t.advance(20 * 60 * 1000);
    await client.request('/me');
    const after = await own();
    expect(after.lastSeenAt).toBe(Date.now());
    expect(after.lastSeenAt).toBeGreaterThan(before.lastSeenAt);
    // A refresh renews the session's activity time; the device row itself is not written.
    expect(
      (
        await t.rows<{ last_seen_at: number }>(
          'SELECT last_seen_at FROM ultra_devices WHERE id=$1',
          [before.id],
        )
      )[0],
    ).toEqual(stored[0]);
    const sessions =
      await client.request<{ current: boolean; lastSeenAt: number }[]>('/sessions');
    expect(sessions.find((row) => row.current)!.lastSeenAt).toBe(Date.now());
  });

  it('removes devices, sessions and pending challenges together with the account', async () => {
    const email = 'gone@example.test';
    const { client } = await h.register(email, 'gone');
    await t.addDevice(email, 'Second device');
    await t.signIn(email);
    const id = client.account!.id;
    expect(await t.pending(id)).toBe(1);
    await client.deleteAccount();
    for (const table of ['ultra_devices', 'ultra_sessions'])
      expect(
        await t.count(`SELECT count(*) AS n FROM ${table} WHERE account_id=$1`, [id]),
      ).toBe(0);
    expect(await t.pending(id)).toBe(0);
    expect(
      await t.count('SELECT count(*) AS n FROM ultra_accounts WHERE id=$1', [id]),
    ).toBe(0);
  });

  it('validates bodies strictly and answers 400 for malformed handles or codes', async () => {
    const token = 'A'.repeat(43);
    for (const body of [
      { token, code: '1234567' },
      { token, code: '123456789' },
      { token, code: 'abcdefgh' },
      { token: 'short', code: '12345678' },
      { token, code: '12345678', extra: true },
    ])
      await expect(h.transport('/login/device/verify', body)).rejects.toMatchObject({
        status: 400,
      });
    await expect(
      h.transport('/login/device/resend', { token, extra: 1 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(t.verify(token, '12345678')).rejects.toMatchObject({
      status: 401,
      message: WRONG,
    });
    await expect(t.resend(token)).rejects.toMatchObject({ status: 401 });
    const { client } = await h.register('strict-revoke@example.test', 'strictrevoke');
    for (const body of [
      { deviceId: 'not-a-uuid' },
      { deviceId: crypto.randomUUID(), extra: true },
      { deviceId: crypto.randomUUID(), code: '123' },
    ])
      await expect(client.request('/devices/revoke', body)).rejects.toMatchObject({
        status: 400,
      });
  });

  it('lets a device remove itself freely, but needs a recent sign-in, and the factor, to remove another one', async () => {
    const email = 'removal@example.test';
    const { client: a } = await h.register(email, 'removal');
    const b = await t.addDevice(email, 'Second device');
    await t.addDevice(email, 'Third device');
    const idOf = async (label: string) =>
      (await a.devices()).find((row) => row.label === label)!.id;
    const secondId = await idOf('Second device');
    const thirdId = await idOf('Third device');
    const present = (id: string) =>
      t.count('SELECT count(*) AS n FROM ultra_devices WHERE id=$1', [id]);
    t.freeze();
    t.advance(11 * 60 * 1000);
    // Every sign-in above is now older than ten minutes: another device cannot be removed...
    await expect(a.revokeDevice(thirdId)).rejects.toMatchObject({ status: 403 });
    expect(await present(thirdId)).toBe(1);
    // ...but the device you are signed in on always can remove itself.
    await b.revokeDevice(secondId);
    expect(await present(secondId)).toBe(0);
    await expect(b.request('/me')).rejects.toMatchObject({ status: 401 });
    vi.useRealTimers();
    // A recent sign-in may remove another device.
    await a.revokeDevice(thirdId);
    expect(await present(thirdId)).toBe(0);

    // With a second factor enrolled the removal also needs its code.
    const mfaEmail = 'removal-mfa@example.test';
    const { client: m } = await h.register(mfaEmail, 'removalmfa');
    const codes = await t.enrollTotp(m);
    const second = h.client();
    await second.login(mfaEmail, password, 'Second device');
    await second.completeMfa(codes[0]);
    const other = (await m.devices()).find((row) => !row.current)!;
    await expect(m.revokeDevice(other.id)).rejects.toMatchObject({ status: 401 });
    await expect(m.revokeDevice(other.id, '000000')).rejects.toMatchObject({
      status: 401,
    });
    expect(await m.devices()).toHaveLength(2);
    await m.revokeDevice(other.id, codes[1]);
    expect(await m.devices()).toHaveLength(1);
    // The device itself never needs a code.
    await m.revokeDevice((await m.devices())[0].id);
  });

  it('never evicts a pending challenge: the owner can still finish after a password holder opens ten more', async () => {
    const email = 'pending@example.test';
    const declare = { clientFeatures: ['deviceEmail'] };
    const { client: first } = await h.register(email, 'pending');
    const { client: owner } = await t.signIn(email);
    const code = t.lastCode(email);
    for (let i = 0; i < 10; i++) await h.legacyLogin(email, password, declare);
    // The owner's challenge plus ten more: eleven pending, none evicted. (With the old limit of
    // five pending the owner's would have been pushed out after the fifth.)
    expect(await t.pending(first.account!.id)).toBe(11);
    // Twelve emails have been sent this hour: the budget, not eviction, stops the flood.
    await expect(h.legacyLogin(email, password, declare)).rejects.toMatchObject({
      status: 429,
      code: 'verification_rate_limited',
    });
    expect(await t.pending(first.account!.id)).toBe(11);
    await owner.completeDeviceVerification(code);
    expect(owner.unlocked).toBeDefined();
  });

  it('clears the email budget when the password changes or the account is recovered', async () => {
    const email = 'budget-reset@example.test';
    const declare = { clientFeatures: ['deviceEmail'] };
    const next = 'a changed password for the budget test';
    const last = 'a recovered password for the budget test';
    const { client, prepared } = await h.register(email, 'budgetreset');
    const exhaust = async (pw: string) => {
      for (let i = 0; i < 20; i++) {
        const outcome = await h.legacyLogin(email, pw, declare).then(
          () => 'sent',
          (error: { status: number; code?: string }) => error,
        );
        if (outcome === 'sent') continue;
        expect(outcome).toMatchObject({ status: 429, code: 'verification_rate_limited' });
        return;
      }
      throw new Error('The email budget was never exhausted');
    };
    await exhaust(password);
    await client.changePassword(next);
    // An attacker's earlier exhaustion does not block the owner's next sign-in.
    expect(await h.legacyLogin(email, next, declare)).toHaveProperty('verification');
    await exhaust(next);
    await h.transport('/recovery/request', { identifier: email });
    const mailToken = h.mail.findLast((message) => message.kind === 'recover')!.token;
    await h.client().recover(mailToken, prepared.recoveryKey, last);
    expect(await h.legacyLogin(email, last, declare)).toHaveProperty('verification');
  });

  it('never issues a session from an email code once a second factor exists, even without the enrolment cleanup', async () => {
    const email = 'recheck@example.test';
    const { client } = await h.register(email, 'recheck');
    const accountId = client.account!.id;
    const { result } = await t.signIn(email);
    const token = result.verification!.token;
    const code = t.lastCode(email);
    // Insert a factor directly: the route-level cleanup of pending challenges is bypassed, so only
    // the re-check at resend and verify stands between the code and a session.
    await h.db.$executeRaw(
      Prisma.sql`INSERT INTO ultra_factors(id,account_id,kind,enabled,data,last_step) VALUES (${crypto.randomUUID()},${accountId},'totp',true,'{"encrypted":"x"}'::jsonb,-1)`,
    );
    const sessions = () =>
      t.count('SELECT count(*) AS n FROM ultra_sessions WHERE account_id=$1', [
        accountId,
      ]);
    const known = { sessions: await sessions(), mail: t.deviceMail(email).length };
    t.freeze();
    t.advance(31000);
    await expect(t.resend(token)).rejects.toMatchObject({ status: 401 });
    expect(t.deviceMail(email)).toHaveLength(known.mail);
    await expect(t.verify(token, code)).rejects.toMatchObject({ status: 401 });
    expect(await sessions()).toBe(known.sessions);
    // The account now answers a password sign-in with the factor step, never an email challenge.
    expect(await h.legacyLogin(email)).toMatchObject({ mfaToken: expect.any(String) });
  });

  it('deletes pending challenges when a second factor is enrolled', async () => {
    const email = 'enrol@example.test';
    const { client } = await h.register(email, 'enrol');
    await t.signIn(email);
    await t.signIn(email);
    expect(await t.pending(client.account!.id)).toBe(2);
    await t.enrollTotp(client);
    expect(await t.pending(client.account!.id)).toBe(0);
  });
});

describe('older clients and older assumptions (SDK 0.1.4 request shapes)', () => {
  let h: Harness;
  let t: ReturnType<typeof toolkit>;
  beforeAll(async () => {
    h = await createHarness({
      privateOnly: true,
      deviceEmailVerification: true,
      disableRateLimit: true,
    });
    t = toolkit(h);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => h.close());

  it('refuses a new device with 426 and issues nothing, but leaves opted-out accounts unchanged', async () => {
    const email = 'legacy@example.test';
    const { client } = await h.register(email, 'legacy');
    const accountId = client.account!.id;
    const mails = t.deviceMail(email).length;
    const devices = () =>
      t.count('SELECT count(*) AS n FROM ultra_devices WHERE account_id=$1', [accountId]);
    const sessions = () =>
      t.count('SELECT count(*) AS n FROM ultra_sessions WHERE account_id=$1', [
        accountId,
      ]);
    const known = { devices: await devices(), sessions: await sessions() };

    await expect(h.legacyLogin(email)).rejects.toMatchObject({
      status: 426,
      code: 'client_update_required',
      message: 'Update Ultra Tasks to sign in on a new device.',
    });
    // A bare token without the declaration is not a bypass for an unrecognised device either.
    await expect(
      h.legacyLogin(email, password, { deviceToken: 'A'.repeat(43) }),
    ).rejects.toMatchObject({ status: 426 });
    // Unknown feature names are ignored, so they do not declare support.
    await expect(
      h.legacyLogin(email, password, { clientFeatures: ['somethingElse'] }),
    ).rejects.toMatchObject({ status: 426 });
    expect(t.deviceMail(email)).toHaveLength(mails);
    expect(await t.pending(accountId)).toBe(0);
    expect({ devices: await devices(), sessions: await sessions() }).toEqual(known);

    await client.setNewDeviceEmailVerification(false);
    const body = await h.legacyLogin(email);
    expect(Object.keys(body).sort()).toEqual(
      ['account', 'accessToken', 'expiresIn', 'refreshToken'].sort(),
    );
    expect(await devices()).toBe(known.devices);
    expect(t.deviceMail(email)).toHaveLength(mails);
  });

  it('keeps the multi-factor and browser sign-in response shapes byte-compatible', async () => {
    const email = 'legacy-mfa@example.test';
    const { client } = await h.register(email, 'legacymfa');
    const codes = await t.enrollTotp(client);
    const pending = await h.legacyLogin(email);
    expect(Object.keys(pending).sort()).toEqual(['factors', 'mfaToken']);
    const session = (await h.transport('/mfa/complete', {
      mfaToken: pending.mfaToken,
      code: codes[0],
    })) as Record<string, unknown>;
    // The old client never declared support, so no device is recorded and no token is returned.
    expect(Object.keys(session).sort()).toEqual(
      ['account', 'accessToken', 'expiresIn', 'refreshToken'].sort(),
    );

    const browser = await h.register('legacy-browser@example.test', 'legacybrowser');
    const app = h.client();
    const flow = await app.startBrowserLogin(
      h.config.publicUrl,
      'ultratasks://account-login',
      'Old app',
    );
    await approveBrowserLogin(browser.client, flow.request);
    const proof = {
      ticket: flow.request.ticket,
      state: flow.request.state,
      verifier: flow.verifier,
      serverId: h.config.serverId,
    };
    const redeemed = (await h.transport('/browser-login/poll', proof)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(redeemed).sort()).toEqual(['approval', 'request', 'tokens']);
    const devices = await browser.client.devices();
    expect(devices).toHaveLength(1);
    const sessions =
      await browser.client.request<{ deviceName: string; trusted: boolean }[]>(
        '/sessions',
      );
    expect(sessions.find((row) => row.deviceName === 'Old app')).toMatchObject({
      trusted: false,
    });
  });

  it('rejects malformed device keys, keeping the strict bodies older servers rely on', async () => {
    const email = 'legacy-strict@example.test';
    await h.register(email, 'legacystrict');
    for (const extra of [
      { deviceToken: 'short' },
      { clientFeatures: 'deviceEmail' },
      { clientFeatures: new Array(9).fill('deviceEmail') },
      { somethingElse: true },
    ])
      await expect(h.legacyLogin(email, password, extra)).rejects.toMatchObject({
        status: 400,
      });
  });
});

describe('new-device email verification switched off (operator kill switch or no mail)', () => {
  it('reports the capability as off, challenges nobody and mints no device tokens', async () => {
    const h = await createHarness({ privateOnly: true, deviceEmailVerification: false });
    try {
      const t = toolkit(h);
      const email = 'off@example.test';
      const { client } = await h.register(email, 'off');
      expect((await h.client().init()).features).toMatchObject({
        newDeviceEmailVerification: false,
        trustedDevices: true,
      });
      const { client: second, result } = await t.signIn(email);
      expect(result.verification).toBeUndefined();
      expect(second.unlocked).toBeDefined();
      expect(client.deviceToken).toBeUndefined();
      // Even a client with stale capabilities that declares support gets no token while off.
      const declared = await h.legacyLogin(email, password, {
        clientFeatures: ['deviceEmail'],
      });
      expect(declared).toHaveProperty('accessToken');
      expect(declared).not.toHaveProperty('deviceToken');
      expect(await t.count('SELECT count(*) AS n FROM ultra_devices')).toBe(0);
      expect(h.mail.filter((message) => message.kind === 'device')).toHaveLength(0);
      expect(await client.devices()).toEqual([]);
      // The stored preference is untouched: it applies again once the switch is back on.
      expect((await client.getSecuritySettings()).newDeviceEmailVerification).toBe(true);
      expect((await client.getSecuritySettings()).available).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('rate limits the resend route per address on a server with limits enabled', async () => {
    const h = await createHarness({ privateOnly: true, deviceEmailVerification: true });
    try {
      const t = toolkit(h);
      const email = 'limits@example.test';
      await h.register(email, 'limits');
      const { result } = await t.signIn(email);
      const token = result.verification!.token;
      const outcomes: { status: number; code?: string }[] = [];
      for (let i = 0; i < 12; i++)
        outcomes.push(
          await t.resend(token).then(
            () => ({ status: 200 }),
            (error: { status: number; code?: string }) => ({
              status: error.status,
              code: error.code,
            }),
          ),
        );
      // Ten requests reach the handler (each refused by the cooldown); the rest never do.
      expect(outcomes.map((outcome) => outcome.status)).toEqual(new Array(12).fill(429));
      expect(outcomes.slice(0, 10).map((outcome) => outcome.code)).toEqual(
        new Array(10).fill('resend_too_soon'),
      );
      expect(outcomes.slice(10).map((outcome) => outcome.code)).toEqual([
        undefined,
        undefined,
      ]);
      const limited = await h.app.inject({
        method: 'POST',
        url: '/api/v2/accounts/login/device/resend',
        payload: { token },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().code).toBeUndefined();
    } finally {
      await h.close();
    }
  });
});
