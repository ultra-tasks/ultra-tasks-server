import { afterEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  fingerprint,
  newBrowserLogin,
  approveBrowserLogin,
  browserLoginUrl,
  type PendingBrowserLogin,
} from '@ultra-tasks/account-crypto';
import { createHarness, password } from './ultra-account.helper';

describe.each(['native', 'better-auth'] as const)(
  'browser login with %s sessions',
  (authEngine) => {
    let h: Awaited<ReturnType<typeof createHarness>>;
    afterEach(async () => {
      await h?.close();
    });
    const setup = async (identifier?: string) => {
      h = await createHarness({ authEngine, privateOnly: true });
      const { client: browser } = await h.register(
        'browser-login@example.test',
        'browserlogin',
      );
      const app = h.client();
      const flow = await app.startBrowserLogin(
        h.config.publicUrl,
        'app.ultratasks://account-login',
        'My phone',
        identifier,
      );
      return { browser, app, flow };
    };
    it('starts an installation-bound request without sending a password or private key', async () => {
      h = await createHarness({ authEngine, privateOnly: true });
      const created = await newBrowserLogin({
        serverId: h.config.serverId,
        serverUrl: h.config.publicUrl,
        redirectUri: 'app.ultratasks://account-login',
        deviceName: 'My phone',
      });
      const request = await h.transport('/browser-login/start', created.input);
      expect(request).toMatchObject({ ...created.input, serverId: h.config.serverId });
      expect(JSON.stringify(request)).not.toContain(created.privateKey.d);
      expect(JSON.stringify(request)).not.toContain(created.verifier);
    });
    it('requires explicit approval, transfers the same vault, and rejects replay and wrong proofs', async () => {
      const { browser, app, flow } = await setup();
      expect(await app.pollBrowserLogin()).toBe(false);
      const info = await h.transport('/browser-login/info', {
        ticket: flow.request.ticket,
      });
      expect(await fingerprint(info)).toBe(await fingerprint(flow.request));
      expect(await browserLoginUrl(flow.request)).not.toContain(flow.verifier);
      await approveBrowserLogin(browser, flow.request);
      await expect(
        h.transport('/browser-login/poll', {
          ticket: flow.request.ticket,
          state: flow.request.state,
          serverId: h.config.serverId,
          verifier: 'X'.repeat(43),
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(await app.pollBrowserLogin()).toBe(true);
      expect(app.unlocked?.masterKey).toBe(browser.unlocked!.masterKey);
      expect(app.account?.id).toBe(browser.account!.id);
      expect(app.tokens?.refreshToken).not.toBe(browser.tokens!.refreshToken);
      expect(app.tokens?.accessToken.startsWith('utba1_')).toBe(
        authEngine === 'better-auth',
      );
      await expect(
        h.transport('/browser-login/poll', {
          ticket: flow.request.ticket,
          state: flow.request.state,
          serverId: h.config.serverId,
          verifier: flow.verifier,
        }),
      ).rejects.toMatchObject({ status: 401 });
      const sessions = await app.request<{ deviceName: string }[]>('/sessions');
      expect(sessions.some((s) => s.deviceName === 'My phone')).toBe(true);
    });
    it('rejects a different account, altered state, recipient and installation', async () => {
      const { browser, app, flow } = await setup('another@example.test');
      await expect(approveBrowserLogin(browser, flow.request)).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        h.transport('/browser-login/poll', {
          ticket: flow.request.ticket,
          state: 'X'.repeat(43),
          serverId: h.config.serverId,
          verifier: flow.verifier,
        }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        h.transport('/browser-login/poll', {
          ticket: flow.request.ticket,
          state: flow.request.state,
          serverId: crypto.randomUUID(),
          verifier: flow.verifier,
        }),
      ).rejects.toMatchObject({ status: 401 });
      const other = await newBrowserLogin({
        serverId: h.config.serverId,
        serverUrl: h.config.publicUrl,
        redirectUri: 'ultratasks://account-login',
        deviceName: 'Other',
      });
      await expect(
        app.resumeBrowserLogin({ ...flow, privateKey: other.privateKey }),
      ).rejects.toThrow();
    });
    it('cannot approve with a password-only session when MFA is pending', async () => {
      const { browser, flow } = await setup();
      const { totp } = await import('../src/ultra-account/security');
      const enrollment = await browser.request<{
        secret: string;
        enrollmentToken: string;
      }>('/factors/totp/start', {});
      await browser.request('/factors/totp/finish', {
        enrollmentToken: enrollment.enrollmentToken,
        code: totp(enrollment.secret),
      });
      const pending = h.client();
      expect((await pending.login('browserlogin', password)).mfaToken).toBeTruthy();
      await expect(approveBrowserLogin(pending, flow.request)).rejects.toThrow('Sign in');
      await expect(
        h.transport('/browser-login/approve', { ticket: flow.request.ticket }),
      ).rejects.toMatchObject({ status: 401 });
    });
    it('invalidates canceled, expired and denied requests', async () => {
      const { browser, app, flow } = await setup();
      await app.cancelBrowserLogin();
      await expect(approveBrowserLogin(browser, flow.request)).rejects.toMatchObject({
        status: 401,
      });
      const expired = await app.startBrowserLogin(
        h.config.publicUrl,
        'ultratasks://account-login',
        'Desktop',
      );
      await h.db.$executeRaw(
        Prisma.sql`UPDATE ultra_challenges SET expires_at=0 WHERE kind='browser-login'`,
      );
      await expect(approveBrowserLogin(browser, expired.request)).rejects.toMatchObject({
        status: 401,
      });
      const denied = await app.startBrowserLogin(
        h.config.publicUrl,
        'ultratasks://account-login',
        'Desktop',
      );
      await browser.request('/browser-login/deny', { ticket: denied.request.ticket });
      await expect(app.pollBrowserLogin()).rejects.toMatchObject({ status: 401 });
    });
    it('rejects an approved grant after password change or session revocation', async () => {
      const { browser, app, flow } = await setup();
      await approveBrowserLogin(browser, flow.request);
      await browser.changePassword('a replacement password for browser login');
      await expect(app.pollBrowserLogin()).rejects.toMatchObject({ status: 401 });
      const next = await app.startBrowserLogin(
        h.config.publicUrl,
        'ultratasks://account-login',
        'Desktop',
      );
      await approveBrowserLogin(browser, next.request);
      const sessions =
        await browser.request<{ id: string; current: boolean }[]>('/sessions');
      await browser.request('/sessions/revoke', {
        sessionId: sessions.find((s) => s.current)!.id,
      });
      await expect(app.pollBrowserLogin()).rejects.toMatchObject({ status: 401 });
    });
    it('permits only one concurrent redemption and binds encrypted grants to the original recipient', async () => {
      const { browser, app, flow } = await setup();
      await approveBrowserLogin(browser, flow.request);
      const clone = h.client();
      await clone.resumeBrowserLogin(structuredClone(flow) as PendingBrowserLogin);
      const result = await Promise.allSettled([
        app.pollBrowserLogin(),
        clone.pollBrowserLogin(),
      ]);
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });
  },
);
