import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  _electron,
  expect as browserExpect,
  type Browser,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, password } from './ultra-account.helper';
import { totp } from '../src/ultra-account/security';

describe('Better Auth + OPAQUE through the account website and real app', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let browser: Browser;
  let desktop: ElectronApplication | undefined;
  let origin: string;
  let mfaSecret: string;
  let recoveryCode: string;
  const output = resolve(
    process.env.ULTRA_AUTH_SCREENSHOTS || '.tmp/better-auth-screenshots',
  );
  const screenshot = async (page: Page, name: string) => {
    // The isolated desktop profile can encounter a shortcut owned by another app.
    // Dismiss only that unrelated, visible notice through its normal UI control.
    const shortcutNotice = page.locator('snack-custom').filter({
      hasText: 'Global Shortcut registration failed:',
    });
    if (await shortcutNotice.isVisible())
      await shortcutNotice.getByRole('button', { name: /dismiss/i }).click();
    await page.screenshot({
      path: resolve(output, name + '.png'),
      fullPage: false,
      animations: 'disabled',
    });
  };
  beforeAll(async () => {
    if (!process.env.ULTRA_CLIENT_DIST) throw new Error('ULTRA_CLIENT_DIST is required');
    await mkdir(output, { recursive: true });
    h = await createHarness({ authEngine: 'better-auth', privateOnly: true });
    await h.app.register(fastifyStatic, {
      root: [
        fileURLToPath(new URL('../account-public', import.meta.url)),
        resolve(process.env.ULTRA_CLIENT_DIST),
      ],
      index: false,
    });
    h.app.get('/account', (_, reply) => reply.sendFile('ultra-account.html'));
    h.app.get('/', (_, reply) => reply.sendFile('index.html'));
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No preview address');
    origin = 'http://localhost:' + address.port;
    h.config.publicUrl = origin;
    const { client } = await h.register('preview@example.test', 'preview');
    const enrollment = await client.request<{ secret: string; enrollmentToken: string }>(
      '/factors/totp/start',
      {},
    );
    mfaSecret = enrollment.secret;
    const codes = await client.request<{ recoveryCodes: string[] }>(
      '/factors/totp/finish',
      {
        enrollmentToken: enrollment.enrollmentToken,
        code: totp(enrollment.secret),
      },
    );
    recoveryCode = codes.recoveryCodes[0];
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN,
      headless: true,
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => {
    await desktop?.close();
    await browser?.close();
    await h?.close();
  });

  it('signs in on the website, enforces MFA, and opens the account dashboard', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'light',
    });
    const page = await context.newPage();
    try {
      await page.goto(origin + '/account');
      await page.locator('#status').filter({ hasText: 'Ready.' }).waitFor();
      await page.locator('#login-id').fill('preview');
      await page.locator('#login-password').fill(password);
      await screenshot(page, 'website-01-sign-in');
      await page.locator('#login button:not([type])').click();
      await page.locator('#status').filter({ hasText: 'Complete two-factor' }).waitFor();
      await browserExpect(page.locator('#auth')).toBeHidden();
      await page.locator('#mfa-cancel').click();
      await browserExpect(page.locator('#mfa')).toBeHidden();
      await browserExpect(page.locator('#auth')).toBeVisible();
      await page.locator('#login-password').fill(password);
      await page.locator('#login button:not([type])').click();
      await page.locator('#status').filter({ hasText: 'Complete two-factor' }).waitFor();
      await page.locator('#mfa').scrollIntoViewIfNeeded();
      await screenshot(page, 'website-02-two-factor');
      await page.locator('#mfa-code').fill(recoveryCode);
      await page.locator('#mfa button').first().click();
      await page.locator('#status').filter({ hasText: 'Signed in.' }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await screenshot(page, 'website-03-dashboard');
      await browserExpect(page.locator('#storage-meter')).toHaveAttribute('max', /[1-9]/);
      await page.getByRole('button', { name: 'Security', exact: true }).click();
      await browserExpect(
        page.getByText('Authenticator app', { exact: true }),
      ).toBeVisible();
      await screenshot(page, 'website-04-security');
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      await browserExpect(page.locator('#sessions')).toContainText('This device');
      await page.getByRole('button', { name: 'Profile', exact: true }).click();
      await browserExpect(page.locator('#profile-username')).toHaveValue('preview');
      expect(await h.transport('/capabilities')).toMatchObject({
        features: { betterAuthSessions: true },
      });
      expect(
        Number(
          (
            await h.database.query<{ count: number }>(
              'SELECT count(*) FROM ultra_better_auth_sessions',
            )
          ).rows[0].count,
        ),
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('keeps account flows usable on a narrow screen in both themes', async () => {
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme,
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await page.goto(origin + '/account');
        await page.locator('#status').filter({ hasText: 'Ready.' }).waitFor();
        await browserExpect(page.locator('#signup')).toBeHidden();
        await page
          .getByRole('button', { name: 'Create an account', exact: true })
          .click();
        await browserExpect(page.locator('#signup-email')).toBeFocused();
        await browserExpect(page.locator('#login')).toBeHidden();
        await screenshot(page, 'website-05-create-account-' + colorScheme);
        await page.getByRole('button', { name: 'Back to sign in' }).click();
        await page.getByRole('button', { name: 'Forgot your password?' }).click();
        await browserExpect(page.locator('#recover-request')).toBeVisible();
        await browserExpect(page.locator('#signup')).toBeHidden();
        await page.getByRole('button', { name: 'Back to sign in' }).click();
        await page.locator('#login-id').fill('preview');
        await page.locator('#login-password').fill('incorrect password');
        await page.locator('#login button.primary').click();
        await browserExpect(page.locator('#status')).toHaveAttribute(
          'data-tone',
          'error',
        );
        await browserExpect(page.locator('#login-password')).toHaveValue('');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        await screenshot(page, 'website-06-sign-in-mobile-' + colorScheme);
      } finally {
        await context.close();
      }
    }
  });

  it('signs in on the app, completes TOTP, and links encrypted personal sync', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let page: Page;
    if (process.env.ULTRA_ELECTRON_EXECUTABLE) {
      desktop = await _electron.launch({
        executablePath: process.env.ULTRA_ELECTRON_EXECUTABLE,
        args: [
          ...(process.env.ULTRA_ELECTRON_APP ? [process.env.ULTRA_ELECTRON_APP] : []),
          '--custom-url=' + origin + '/#/native-sync',
          '--user-data-dir=' + resolve(output, '../electron-profile'),
          '--disable-tray',
          '--no-sandbox',
        ],
        env: { ...process.env, NODE_ENV: 'production' },
      });
      page = await desktop.firstWindow();
      await desktop.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].setSize(1440, 1000);
      });
    } else {
      page = await context.newPage();
    }
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
      await page.addInitScript(() => {
        for (const key of [
          'SUP_ONBOARDING_PRESET_DONE',
          'SUP_ONBOARDING_HINTS_DONE',
          'SUP_IS_SHOW_TOUR',
          'SUP_EXAMPLE_TASKS_CREATED',
        ])
          localStorage.setItem(key, 'true');
      });
      page.on('dialog', (dialog) => {
        void dialog.dismiss();
      });
      await page.goto(origin + '/#/native-sync');
      await page.getByLabel('Ultra Tasks server URL').fill(origin);
      await page.getByLabel('Email or username').fill('preview');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await screenshot(page, 'app-01-sign-in');
      await page.getByRole('button', { name: 'Sign in and unlock' }).click();
      await page.getByLabel('Authenticator or 2FA recovery code').waitFor();
      await browserExpect(
        page.getByRole('button', { name: 'Use security key or passkey' }),
      ).toHaveCount(0);
      await page.getByLabel('Authenticator or 2FA recovery code').fill('cancelled code');
      await page.getByRole('button', { name: 'Back to sign in', exact: true }).click();
      await browserExpect(page.getByLabel('Password', { exact: true })).toHaveValue('');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in and unlock' }).click();
      await browserExpect(
        page.getByLabel('Authenticator or 2FA recovery code'),
      ).toHaveValue('');
      await screenshot(page, 'app-02-two-factor');
      await page
        .getByLabel('Authenticator or 2FA recovery code')
        .fill(totp(mfaSecret, Math.floor(Date.now() / 30000) + 1));
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      await page.getByText('Connect personal data', { exact: true }).waitFor();
      await page.getByLabel('I have backed up my data').check();
      await page.getByRole('button', { name: 'Import this device’s data' }).click();
      await browserExpect(
        page.getByText('Connect personal data', { exact: true }),
      ).toHaveCount(0, {
        timeout: 30000,
      });
      await browserExpect(
        page.getByRole('button', { name: 'Sync now', exact: true }),
      ).toBeVisible();
      await screenshot(page, 'app-03-connected');
      await browserExpect(page.locator('native-sync [role=alert]')).toHaveCount(0);
    } catch (error) {
      await screenshot(page, 'app-failure');
      console.error('Synthetic app acceptance failure', {
        url: page.url(),
        errors: pageErrors,
        text: (await page.locator('body').innerText()).slice(0, 1500),
      });
      throw error;
    } finally {
      await desktop?.close();
      desktop = undefined;
      await context.close();
    }
  });
});
