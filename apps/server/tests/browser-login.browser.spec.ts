import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  _electron,
  expect as ui,
  type Browser,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  AccountClient,
  httpTransport,
  browserLoginUrl,
} from '@ultra-tasks/account-crypto';
import { createHarness, password } from './ultra-account.helper';
import { totp } from '../src/ultra-account/security';

describe('website-to-app encrypted login on independent server origins', () => {
  let browser: Browser;
  const servers: {
    h: Awaited<ReturnType<typeof createHarness>>;
    origin: string;
    recoveryCodes: string[];
  }[] = [];
  const output = resolve(
    process.env.ULTRA_AUTH_SCREENSHOTS || '.tmp/browser-login-screenshots',
  );
  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    for (const authEngine of ['native', 'better-auth'] as const) {
      const h = await createHarness({ authEngine, privateOnly: true });
      await h.app.register(fastifyStatic, {
        root: [
          fileURLToPath(new URL('../account-public', import.meta.url)),
          ...(process.env.ULTRA_CLIENT_DIST
            ? [resolve(process.env.ULTRA_CLIENT_DIST)]
            : []),
        ],
        index: false,
      });
      h.app.get('/account', (_, reply) => reply.sendFile('ultra-account.html'));
      if (process.env.ULTRA_CLIENT_DIST)
        h.app.get('/', (_, reply) => reply.sendFile('index.html'));
      await h.app.listen({ host: '127.0.0.1', port: 0 });
      const address = h.app.server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing test address');
      const origin = 'http://localhost:' + address.port;
      h.config.publicUrl = origin;
      const { client } = await h.register('handoff@example.test', 'handoff');
      const enrollment = await client.request<{
        secret: string;
        enrollmentToken: string;
      }>('/factors/totp/start', {});
      const { recoveryCodes } = await client.request<{ recoveryCodes: string[] }>(
        '/factors/totp/finish',
        { enrollmentToken: enrollment.enrollmentToken, code: totp(enrollment.secret) },
      );
      servers.push({ h, origin, recoveryCodes });
    }
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN,
      headless: true,
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => {
    await browser?.close();
    for (const { h } of servers) await h.close();
  });
  const preparePage = async (page: Page) => {
    // Capture app navigation through the actual return anchor. Never launch a personal browser/app profile.
    await page.addInitScript(() =>
      document.addEventListener(
        'click',
        (event) => {
          const target =
            event.target instanceof Element ? event.target.closest('a') : null;
          if (target && /^(ultratasks|app\.ultratasks):/.test(target.href)) {
            event.preventDefault();
            (window as unknown as { appReturn: string }).appReturn = target.href;
          }
        },
        true,
      ),
    );
  };
  const loginAndApprove = async (page: Page, url: string, recoveryCode: string) => {
    await preparePage(page);
    await page.goto(url);
    await ui(page.locator('#app-login-context')).toBeVisible();
    await page.locator('#login-id').fill('handoff');
    await page.locator('#login-password').fill(password);
    await page.locator('#login button.primary').click();
    await ui(page.locator('#mfa')).toBeVisible();
    await ui(page.locator('#app-login-approval')).toBeHidden();
    await page.locator('#mfa-code').fill(recoveryCode);
    await page.locator('#mfa button.primary').click();
    await ui(page.locator('#app-login-account')).toHaveText('handoff@example.test');
    await page.screenshot({
      path: resolve(output, 'website-approval.png'),
      fullPage: true,
    });
    await page.locator('#app-login-approve').click();
    await ui(page.locator('#app-login-finished')).toBeVisible();
  };
  it('uses the same MFA and proof-bound polling for desktop, Android and iOS return URIs on each origin', async () => {
    for (const [index, { h, origin, recoveryCodes }] of servers.entries())
      for (const redirectUri of [
        'ultratasks://account-login',
        'app.ultratasks://account-login',
      ] as const) {
        const client = new AccountClient(httpTransport(origin));
        const flow = await client.startBrowserLogin(
          origin,
          redirectUri,
          'My ' + redirectUri.split(':')[0],
        );
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          await loginAndApprove(
            page,
            await browserLoginUrl(flow.request),
            recoveryCodes.shift()!,
          );
          const returned = await page.evaluate(
            () => (window as unknown as { appReturn: string }).appReturn,
          );
          expect(returned).toBe(
            redirectUri +
              '?result=' +
              flow.request.ticket +
              '&state=' +
              flow.request.state,
          );
          expect(returned).not.toContain(flow.verifier);
          expect(returned).not.toContain(flow.privateKey.d);
          // Deliberately do not deliver the callback: this is the blocked-return fallback.
          expect(await client.pollBrowserLogin()).toBe(true);
          expect(client.account?.email).toBe('handoff@example.test');
          await expect(
            servers[1 - index].h.transport('/browser-login/info', {
              ticket: flow.request.ticket,
            }),
          ).rejects.toMatchObject({ status: 401 });
          expect(client.unlocked?.masterKey).toBeTruthy();
        } finally {
          await context.close();
        }
      }
  });
  it.skipIf(!process.env.ULTRA_ELECTRON_EXECUTABLE || !process.env.ULTRA_CLIENT_DIST)(
    'returns to the real desktop app on warm and cold launch',
    async () => {
      const { origin, recoveryCodes } = servers[1];
      for (const cold of [false, true]) {
        let desktop: ElectronApplication | undefined;
        const profile = resolve(output, cold ? 'cold-profile' : 'warm-profile');
        const launch = async (callback?: string) => {
          const app = await _electron.launch({
            executablePath: process.env.ULTRA_ELECTRON_EXECUTABLE!,
            args: [
              ...(process.env.ULTRA_ELECTRON_APP ? [process.env.ULTRA_ELECTRON_APP] : []),
              '--custom-url=' + origin + '/#/native-sync',
              '--user-data-dir=' + profile,
              '--disable-tray',
              '--no-sandbox',
              ...(callback ? [callback] : []),
            ],
            env: { ...process.env, NODE_ENV: 'production' },
          });
          await app.evaluate(({ shell }) => {
            shell.openExternal = async (url) => {
              (globalThis as unknown as { loginUrl: string }).loginUrl = url;
            };
          });
          return app;
        };
        const context = await browser.newContext();
        const web = await context.newPage();
        let appPage: Page | undefined;
        const pageErrors: string[] = [];
        try {
          desktop = await launch();
          let page = await desktop.firstWindow();
          appPage = page;
          page.on('pageerror', (error) => pageErrors.push(error.message));
          await page.addInitScript(() => {
            for (const key of [
              'SUP_ONBOARDING_PRESET_DONE',
              'SUP_ONBOARDING_HINTS_DONE',
              'SUP_IS_SHOW_TOUR',
              'SUP_EXAMPLE_TASKS_CREATED',
            ])
              localStorage.setItem(key, 'true');
          });
          await page.goto(origin + '/#/native-sync');
          await page.getByLabel('Ultra Tasks server URL').fill(origin);
          await page.getByLabel('Email or username').fill('handoff');
          await page
            .getByRole('button', { name: 'Continue in browser', exact: true })
            .click();
          await page
            .getByText('Finish sign-in in your browser', { exact: true })
            .waitFor();
          const url = await desktop.evaluate(
            () => (globalThis as unknown as { loginUrl: string }).loginUrl,
          );
          if (cold) {
            await desktop.close();
            desktop = undefined;
          }
          await loginAndApprove(web, url, recoveryCodes.shift()!);
          const callback = await web.evaluate(
            () => (window as unknown as { appReturn: string }).appReturn,
          );
          if (cold) {
            desktop = await launch(callback);
            page = await desktop.firstWindow();
          } else
            await desktop!.evaluate(({ app }, url) => {
              app.emit('second-instance', {}, ['UltraTasks.exe', url], process.cwd(), {});
            }, callback);
          await ui(page.getByText('Connect personal data', { exact: true })).toBeVisible({
            timeout: 30000,
          });
          const notice = page
            .locator('snack-custom')
            .filter({ hasText: 'Global Shortcut registration failed:' });
          if (await notice.isVisible())
            await notice.getByRole('button', { name: /dismiss/i }).click();
          await page.screenshot({
            path: resolve(
              output,
              cold ? 'desktop-cold-return.png' : 'desktop-warm-return.png',
            ),
            animations: 'disabled',
          });
          await ui(page.locator('native-sync [role=alert]')).toHaveCount(0);
        } catch (error) {
          if (appPage) {
            await appPage.screenshot({ path: resolve(output, 'desktop-failure.png') });
            console.error('Synthetic desktop handoff failure', {
              errors: pageErrors,
              url: appPage.url(),
              text: (await appPage.locator('body').innerText()).slice(0, 2000),
            });
          }
          throw error;
        } finally {
          await desktop?.close();
          await context.close();
        }
      }
    },
  );
});
