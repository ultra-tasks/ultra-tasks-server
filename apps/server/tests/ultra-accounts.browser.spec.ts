import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chromium,
  expect as ui,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import {
  AccountClient,
  browserLoginUrl,
  httpTransport,
  randomKey,
} from '@ultra-tasks/account-crypto';
import { createHarness, password } from './ultra-account.helper';
import { totp } from '../src/ultra-account/security';
import {
  cachedProfiles,
  fitsWidth,
  openAccountPage,
  registerAccount,
  serveDashboard,
  submitSignIn,
  TURNSTILE_CSP,
} from './account-dashboard.helper';

const virtualAuthenticator = async (context: BrowserContext, page: Page) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
};
/** Messages are shown inside the form or panel they describe, never in a floating line. */
const notice = (page: Page, scope: string, tone: string) =>
  page.locator(`${scope} .notice[data-tone="${tone}"]`);
const noticeText = (page: Page, scope: string, tone: string) =>
  notice(page, scope, tone).locator('.notice-text');

describe('encrypted account portal in Chromium with a real virtual WebAuthn authenticator', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let browser: Browser;
  let origin: string;
  it('sends the signup challenge to the server before displaying recovery material', async () => {
    const secured = await createHarness({
      turnstile: { siteKey: 'test-site', secret: 'test-secret', hostname: '127.0.0.1' },
    });
    const securedOrigin = await serveDashboard(secured, '127.0.0.1', TURNSTILE_CSP);
    const context = await browser.newContext();
    const page = await context.newPage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: '127.0.0.1' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);
    try {
      await page.route('https://challenges.cloudflare.com/**', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: "window.turnstile={render:(element,options)=>{options.callback('browser-token');return 'widget'},reset:()=>{}}",
        }),
      );
      await openAccountPage(page, securedOrigin);
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.locator('#signup-email').fill('turnstile@example.test');
      await page.locator('#signup-password').fill(password);
      await page.locator('#signup-confirm').fill(password);
      await page.locator('#signup button.primary').click();
      await ui(page.locator('#recovery-sheet')).toBeVisible({ timeout: 20000 });
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(JSON.stringify(mockFetch.mock.calls)).toContain('browser-token');
    } finally {
      vi.unstubAllGlobals();
      await context.close();
      await secured.close();
    }
  }, 60000);
  beforeAll(async () => {
    h = await createHarness();
    origin = await serveDashboard(h);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN,
      headless: true,
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('requires an explicit confirmation before deleting an account and clears its cached profile', async () => {
    await h.register('delete-dashboard@example.test', 'deletedashboard');
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openAccountPage(page, origin);
      await submitSignIn(page, 'delete-dashboard@example.test', password);
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      await page.getByRole('button', { name: 'Security', exact: true }).click();
      // The danger zone is separate, explains the consequences and is collapsed.
      const zone = page.locator('.danger-zone');
      await ui(zone).toContainText('permanently deletes your account');
      await ui(zone).toContainText('Server backups may retain encrypted copies');
      await page.getByText('Delete my account…', { exact: true }).click();
      await page.locator('#delete-confirm-email').fill('someone-else@example.test');
      await page.locator('#delete-confirm').check();
      await page.getByRole('button', { name: 'Permanently delete account' }).click();
      await ui(notice(page, '#panel-security', 'error')).toContainText(
        'Confirm your account email',
      );
      // A wrong confirmation changed nothing.
      await expect(
        h.client().login('delete-dashboard@example.test', password),
      ).resolves.toBeTruthy();
      await page.locator('#delete-confirm-email').fill('delete-dashboard@example.test');
      await page.getByRole('button', { name: 'Permanently delete account' }).click();
      await ui(notice(page, '#login', 'success')).toContainText('deleted', {
        timeout: 30000,
      });
      await ui(page.locator('#dashboard')).toBeHidden();
      await expect(h.client().login('deletedashboard', password)).rejects.toThrow();
      expect(JSON.parse(await cachedProfiles(page))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60000);

  it('registers with saved recovery material, verifies email, uses WebAuthn 2FA, recovers the password, and unlocks offline', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) errors.push(message.text());
    });
    await virtualAuthenticator(context, page);
    await openAccountPage(page, origin);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    // Sign-up asks for email and password only; the three steps are announced.
    await ui(page.locator('#signup .steps li[aria-current="step"]')).toContainText(
      'Account',
    );
    await page.locator('#signup-email').fill('browser@example.test');
    await page.locator('#signup-password').fill(password);
    await page.locator('#signup-confirm').fill(password);
    await page.locator('#signup button.primary').click();
    await ui(page.locator('#recovery-sheet')).toBeVisible({ timeout: 20000 });
    await ui(page.locator('#recovery-steps li[aria-current="step"]')).toContainText(
      'Recovery key',
    );
    const discardedKey = (await page.locator('#recovery-material').textContent())!;
    expect(await page.locator('#signup-back').count()).toBe(1);
    await page.locator('#signup-back').click();
    expect(await page.locator('#recovery-sheet').isHidden()).toBe(true);
    expect(await page.locator('#recovery-material').textContent()).toBe('');
    expect(await page.locator('#signup').isVisible()).toBe(true);
    expect(await page.locator('#signup-password').inputValue()).toBe('');
    expect(await page.locator('#signup-confirm').inputValue()).toBe('');
    await ui(notice(page, '#signup', 'info')).toContainText('Recovery key discarded');
    await page.locator('#signup-password').fill(password);
    await page.locator('#signup-confirm').fill(password);
    await page.locator('#signup button.primary').click();
    await ui(page.locator('#recovery-sheet')).toBeVisible({ timeout: 20000 });
    const recoveryKey = (await page.locator('#recovery-material').textContent())!;
    expect(recoveryKey).toMatch(/^UTRK1-/);
    expect(recoveryKey).not.toBe(discardedKey);
    expect(await page.locator('#recovery-sheet').textContent()).toContain(
      'lose access to your encrypted data',
    );
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download-recovery').click();
    const download = await downloadPromise;
    const saved = await readFile((await download.path())!, 'utf8');
    expect(saved).toContain(recoveryKey);
    expect(saved).toContain('cannot decrypt data');
    await page.locator('#copy-recovery').click();
    await ui(notice(page, '#recovery-sheet', 'success')).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      recoveryKey,
    );
    // The key cannot be skipped: the saved-key confirmation is required.
    await page.locator('#finish-signup button.primary').click();
    expect(
      await page
        .locator('#saved-key')
        .evaluate((box) => (box as HTMLInputElement).validity.valueMissing),
    ).toBe(true);
    expect(
      h.mail.filter((message) => message.email === 'browser@example.test'),
    ).toHaveLength(0);
    await page.locator('#saved-key').check();
    await page.locator('#finish-signup button.primary').click();
    await ui(page.locator('#verify-email')).toBeVisible();
    await ui(page.locator('#verify-steps li[aria-current="step"]')).toContainText(
      'Verify email',
    );
    await ui(page.locator('#verify-lede')).toContainText('b***@example.test');
    await ui(page.locator('#verify-email')).toContainText('30 minutes');
    await page
      .locator('#verify-token')
      .fill(h.mail.findLast((message) => message.kind === 'verify')!.token);
    await page.locator('#verify-email button.primary').click();
    await ui(notice(page, '#login', 'success')).toContainText('Email verified');
    // The new account has no username or display name: it signs in with its email.
    await submitSignIn(page, 'browser@example.test', password);
    await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
    await ui(page.locator('#storage-summary')).toContainText('Nothing is synced yet');
    expect(await page.locator('#server-address').textContent()).toBe(origin);
    const accountId = (
      await h.database.query<{ id: string }>(
        "SELECT id FROM ultra_accounts WHERE email='browser@example.test'",
      )
    ).rows[0].id;
    expect(await page.locator('#account-id').textContent()).toBe(accountId);
    await page.locator('#copy-account-id').click();
    await ui(page.locator('#copy-account-id-status')).toHaveText('Copied to clipboard.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(accountId);
    await page.screenshot({
      path: fileURLToPath(
        new URL('../../../.tmp/account-dashboard.png', import.meta.url),
      ),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Security', exact: true }).click();
    await page.locator('#webauthn-enroll').click();
    await ui(page.locator('#recovery-sheet')).toBeVisible({ timeout: 20000 });
    const mfaCodes = (await page.locator('#recovery-material').textContent())!.split(
      '\n',
    );
    expect(mfaCodes).toHaveLength(10);
    expect(mfaCodes[0]).toMatch(/^UTMFA-/);
    // Recovery codes are shown once: they must be acknowledged before leaving.
    await page.locator('#finish-codes button.primary').click();
    expect(
      await page
        .locator('#saved-codes')
        .evaluate((box) => (box as HTMLInputElement).validity.valueMissing),
    ).toBe(true);
    await page.locator('#saved-codes').check();
    await page.locator('#finish-codes button.primary').click();
    await ui(page.locator('#panel-security')).toBeVisible();
    await ui(notice(page, '#panel-security', 'success')).toContainText(
      'Two-factor authentication is on',
    );
    await ui(page.locator('#factors')).toContainText('Security key or passkey');
    await ui(page.locator('#factors-summary')).toContainText(
      'On. Signing in asks for a second step',
    );
    await page.locator('#logout').click();
    await ui(notice(page, '#login', 'info')).toContainText('Signed out');
    await submitSignIn(page, 'browser@example.test', password);
    await ui(page.locator('#mfa')).toBeVisible();
    await page.locator('#webauthn-login').click();
    await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Security', exact: true }).click();
    expect(await page.locator('#factors').textContent()).toContain(
      'Security key or passkey',
    );
    await page.locator('#logout').click();
    await ui(page.locator('#login')).toBeVisible();
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await page.locator('#recover-id').fill('browser@example.test');
    await page.locator('#recover-request button.primary').click();
    await ui(notice(page, '#recover-request', 'success')).toContainText(
      'check your email',
    );
    const mailToken = h.mail.findLast((message) => message.kind === 'recover')!.token;
    await openAccountPage(page, origin, '?recover=' + mailToken);
    expect(page.url()).toBe(origin + '/account');
    await ui(page.locator('#recover-finish')).toBeVisible();
    await page.locator('#recover-key').fill(recoveryKey);
    await page.locator('#recover-password').fill('a recovered browser password');
    await page.locator('#recover-password-confirm').fill('a recovered browser password');
    await page.locator('#recover-mfa').fill(mfaCodes[0]);
    await page.locator('#recover-finish button.primary').click();
    await ui(notice(page, '#login', 'success')).toContainText('Password recovered');
    await submitSignIn(page, 'browser@example.test', 'a recovered browser password');
    await ui(page.locator('#mfa')).toBeVisible();
    await page.locator('#webauthn-login').click();
    await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
    const storage = await cachedProfiles(page);
    expect(storage).not.toContain(password);
    expect(storage).not.toContain('a recovered browser password');
    expect(storage).not.toContain(recoveryKey);
    await page.locator('#lock').click();
    await ui(notice(page, '#login', 'info')).toContainText('Locked');
    await context.setOffline(true);
    await page.locator('#login-id').fill('browser@example.test');
    await page.locator('#login-password').fill('a recovered browser password');
    // Offline unlock lives under Advanced and only appears when this browser has a cache.
    await page.getByText('Advanced', { exact: true }).click();
    await page.locator('#offline-unlock').click();
    await ui(page.locator('#offline-state')).toBeVisible();
    await ui(page.locator('#offline-state')).toContainText('unlocked');
    await ui(page.locator('#offline-email')).toHaveText('browser@example.test');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('approves a native or custom-origin login on the server origin and requires the device-only proof to redeem it', async () => {
    const registered = await h.register('nativepasskey@example.test', 'nativepasskey');
    const context = await browser.newContext();
    const page = await context.newPage();
    await virtualAuthenticator(context, page);
    await openAccountPage(page, origin);
    // A legacy username still signs in, though the new form only asks for email.
    await submitSignIn(page, 'nativepasskey', password);
    await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Security', exact: true }).click();
    await page.locator('#webauthn-enroll').click();
    await expect
      .poll(() => page.locator('#recovery-material').textContent())
      .toContain('UTMFA-');
    const native = h.client();
    const result = await native.login('nativepasskey', password, 'My native phone');
    expect(result.mfaToken).toBeTruthy();
    expect(native.tokens).toBeUndefined();
    const flow = await native.startBrowserMfa();
    expect(flow.url).not.toContain(flow.deviceSecret);
    expect(await native.pollBrowserMfa(flow)).toBe(false);
    await expect(
      h.transport('/mfa/browser/poll', {
        ticket: flow.ticket,
        deviceSecret: randomKey(),
      }),
    ).rejects.toMatchObject({ status: 401 });
    await page.goto(flow.url);
    await ui(page.locator('#device-approval')).toBeVisible();
    await page.locator('#device-approve').click();
    await ui(notice(page, '#device-approval', 'success')).toContainText(
      'Device sign-in approved',
    );
    expect(page.url()).toBe(origin + '/account');
    expect(await native.pollBrowserMfa(flow)).toBe(true);
    expect(native.unlocked?.masterKey).toBe(registered.client.unlocked!.masterKey);
    await expect(
      native.transport('/mfa/browser/poll', {
        ticket: flow.ticket,
        deviceSecret: flow.deviceSecret,
      }),
    ).rejects.toMatchObject({ status: 401 });
    const stale = h.client();
    await stale.login('nativepasskey', password);
    const obsolete = await stale.startBrowserMfa();
    await native.changePassword('changed password invalidates pending native login');
    await expect(stale.pollBrowserMfa(obsolete)).rejects.toMatchObject({ status: 401 });
    await context.close();
  }, 90000);
});

describe('account website sign-in, sign-up and dashboard flows', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    h = await createHarness({ requireTermsConsent: true, hasOperatorTerms: true });
    origin = await serveDashboard(h);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN,
      headless: true,
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('leads with one clear sign-in heading, derives the device name and works from the keyboard alone', async () => {
    await registerAccount(h, 'keyboard@example.test');
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    });
    const page = await context.newPage();
    const profileRequests: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/login/start'))
        profileRequests.push(JSON.parse(request.postData() ?? '{}'));
    });
    try {
      await openAccountPage(page, origin);
      await expect(page.title()).resolves.toBe('Sign in – Ultra Tasks account');
      // One h1 that names the page, with no floating status line above the card.
      await ui(page.getByRole('heading', { level: 1 })).toHaveText(
        'Sign in to your Ultra Tasks account',
      );
      expect(await page.locator('#status').count()).toBe(0);
      const form = page.locator('#login');
      await ui(form.getByLabel('Email', { exact: true })).toHaveAttribute(
        'autocomplete',
        'username',
      );
      await ui(form.getByLabel('Password', { exact: true })).toHaveAttribute(
        'autocomplete',
        'current-password',
      );
      await ui(page.getByLabel('Username')).toHaveCount(0);
      await ui(page.getByLabel(/email or username/i)).toHaveCount(0);
      await ui(
        page.getByRole('button', { name: 'Create account', exact: true }),
      ).toBeVisible();
      await ui(page.getByRole('button', { name: 'Forgot password?' })).toBeVisible();
      // The device name is not part of the first view; it sits under Advanced.
      await ui(page.locator('#device-name')).toBeHidden();
      await ui(page.locator('#offline-unlock')).toBeHidden();
      await ui(page.locator('#resend-verification')).toBeHidden();
      await page.getByText('Advanced', { exact: true }).click();
      await ui(page.locator('#device-name')).toHaveValue('Firefox on Windows');
      await page.getByText('Advanced', { exact: true }).click();
      // Show and hide keep the same field, so pasted or autofilled values survive.
      const secretField = form.getByLabel('Password', { exact: true });
      await secretField.fill('pasted value');
      const toggle = form.getByRole('button', { name: 'Show password' });
      await toggle.click();
      await ui(secretField).toHaveAttribute('type', 'text');
      await ui(toggle).toHaveAttribute('aria-pressed', 'true');
      await toggle.click();
      await ui(secretField).toHaveAttribute('type', 'password');
      await ui(secretField).toHaveValue('pasted value');
      // Keyboard only, from a fresh page: Tab to the email field, type, Tab to the
      // password, Enter. Nothing needs a pointer.
      await openAccountPage(page, origin);
      for (let step = 0; step < 6; step++) {
        await page.keyboard.press('Tab');
        if ((await page.evaluate(() => document.activeElement?.id)) === 'login-id') break;
      }
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('login-id');
      await page.keyboard.type('keyboard@example.test');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'login-password',
      );
      await page.keyboard.type(password);
      await page.keyboard.press('Enter');
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      // Focus moved to the new page's heading, and the title follows the section.
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('dash-title');
      await expect(page.title()).resolves.toBe('Account – Ultra Tasks account');
      expect(profileRequests[0]).toMatchObject({ deviceName: 'Firefox on Windows' });
      // The derived label is only a label in the device list.
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      const row = page.locator('#sessions li').filter({ hasText: 'Firefox on Windows' });
      await ui(row.locator('.badge', { hasText: 'This device' })).toBeVisible();
      expect(await page.locator('[style]').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 90000);

  it('asks for email and password only when creating an account and keeps the consent safeguard', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const registerBodies: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/register/start'))
        registerBodies.push(JSON.parse(request.postData() ?? '{}'));
    });
    try {
      await openAccountPage(page, origin);
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await ui(page.locator('#signup-email')).toBeFocused();
      await expect(page.title()).resolves.toBe('Create account – Ultra Tasks account');
      const form = page.locator('#signup');
      await ui(form.getByLabel('Email', { exact: true })).toBeVisible();
      await ui(form.getByLabel('Password', { exact: true })).toBeVisible();
      await ui(form.getByLabel('Confirm password')).toBeVisible();
      // No username and no display name anywhere in the flow.
      for (const retired of [
        '#signup-username',
        '#signup-name',
        '#profile-username',
        '#profile-name',
      ])
        expect(await page.locator(retired).count()).toBe(0);
      await ui(page.getByLabel(/username|display name/i)).toHaveCount(0);
      await ui(form.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
      await ui(form.locator('.steps li')).toHaveText([
        '1Account',
        '2Recovery key',
        '3Verify email',
      ]);
      // Consent is shown, linked, and required before anything is sent.
      await ui(form.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
      await ui(form.getByRole('link', { name: 'Terms of Service' })).toBeVisible();
      await form.getByLabel('Email', { exact: true }).fill('consent@example.test');
      await form.getByLabel('Password', { exact: true }).fill(password);
      await form.getByLabel('Confirm password').fill(password);
      await form.getByRole('button', { name: 'Continue', exact: true }).click();
      expect(registerBodies).toHaveLength(0);
      await ui(page.locator('#signup-consent-accepted')).toBeFocused();
      // A mismatch is explained next to the fields and clears both passwords.
      await page.locator('#signup-consent-accepted').check();
      await form.getByLabel('Confirm password').fill('some other password value');
      await form.getByRole('button', { name: 'Continue', exact: true }).click();
      await ui(notice(page, '#signup', 'error')).toContainText('passwords do not match');
      await ui(page.locator('#signup-password')).toHaveAttribute('aria-invalid', 'true');
      await ui(page.locator('#signup-password')).toHaveValue('');
      await form.getByLabel('Password', { exact: true }).fill(password);
      await form.getByLabel('Confirm password').fill(password);
      await form.getByRole('button', { name: 'Continue', exact: true }).click();
      await ui(page.locator('#recovery-sheet')).toBeVisible({ timeout: 20000 });
      expect(registerBodies).toHaveLength(1);
      expect(Object.keys(registerBodies[0]).sort()).toEqual([
        'email',
        'registrationRequest',
        'termsAccepted',
      ]);
      expect(registerBodies[0]).toMatchObject({
        email: 'consent@example.test',
        termsAccepted: true,
      });
    } finally {
      await context.close();
    }
  }, 60000);

  it('shows the account email, a copyable Account ID, devices with a confirmed removal, and changes email by verification', async () => {
    const client = await registerAccount(h, 'account-page@example.test');
    const accountId = client.account!.id;
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    const profileBodies: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/profile') && request.method() === 'PUT')
        profileBodies.push(JSON.parse(request.postData() ?? '{}'));
    });
    try {
      await openAccountPage(page, origin);
      await submitSignIn(page, 'account-page@example.test', password);
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      // The shell names the product and shows who is signed in; navigation is three areas.
      await ui(page.getByRole('heading', { level: 1 })).toHaveText('Ultra Tasks account');
      await ui(page.locator('#who')).toHaveText('account-page@example.test');
      await ui(page.locator('.settings-nav button')).toHaveText([
        'Account',
        'Security',
        'Devices',
      ]);
      await ui(
        page.getByRole('button', { name: 'Lock', exact: true }),
      ).toHaveAccessibleDescription(/clears your encryption keys/i);
      await ui(
        page.getByRole('button', { name: 'Sign out', exact: true }),
      ).toHaveAccessibleDescription(/ends this browser’s session/i);
      // Account: email, Account ID (the existing account id), server address, quiet storage.
      await ui(page.locator('#account-email')).toHaveText('account-page@example.test');
      await ui(page.locator('#account-id')).toHaveText(accountId);
      await ui(page.locator('#account-id')).toHaveCSS(
        'font-family',
        /mono|Consolas|Menlo|Courier/i,
      );
      await ui(page.locator('#account-id-help')).toContainText(
        'It is not a password and does not prove you own the account.',
      );
      await ui(page.locator('#storage-summary')).toContainText('Nothing is synced yet');
      await ui(page.locator('#storage-meter')).toBeHidden();
      await ui(page.getByRole('link', { name: 'Get Ultra Tasks' })).toBeVisible();
      await ui(page.locator('#calendar-publications')).toBeHidden();
      await page.locator('#copy-account-id').click();
      await ui(page.locator('#copy-account-id-status')).toHaveText(
        'Copied to clipboard.',
      );
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(accountId);
      // Change email: an email-only form that sends a verification link.
      await page.getByRole('button', { name: 'Change email' }).click();
      await page.getByLabel('New email address').fill('account-page-new@example.test');
      await page.getByRole('button', { name: 'Send verification link' }).click();
      await ui(notice(page, '#panel-account', 'success')).toContainText(
        'verification link to account-page-new@example.test',
      );
      expect(profileBodies).toHaveLength(1);
      expect(profileBodies[0]).toEqual({ email: 'account-page-new@example.test' });
      const link = h.mail.findLast(
        (message) => message.email === 'account-page-new@example.test',
      )!;
      expect(link.kind).toBe('verify');
      // The emailed link opens the page with its token, which is removed from the address.
      const linked = await context.newPage();
      await openAccountPage(linked, origin, '?verify=' + link.token);
      expect(linked.url()).toBe(origin + '/account');
      await ui(linked.locator('#verify-email')).toBeVisible();
      await ui(linked.locator('#verify-steps')).toBeHidden();
      await linked.locator('#verify-email button.primary').click();
      await ui(notice(linked, '#login', 'success')).toContainText('Email verified');
      await linked.close();
      expect(
        (
          await h.database.query<{ email: string }>(
            'SELECT email FROM ultra_accounts WHERE id=$1',
            [accountId],
          )
        ).rows[0].email,
      ).toBe('account-page-new@example.test');
      // Security without the new-device feature (it is off on this harness): no such control.
      await page.getByRole('button', { name: 'Security', exact: true }).click();
      await ui(page.locator('#new-device-row')).toBeHidden();
      await ui(page.getByRole('heading', { name: 'Sign-in protection' })).toBeVisible();
      await ui(page.locator('#factors-summary')).toContainText('Off');
      await ui(page.locator('#password-details')).not.toHaveAttribute('open', '');
      await page.locator('#password-details > summary').click();
      await page.locator('#new-password').fill('a brand new long password');
      await page.locator('#new-password-confirm').fill('a different long password');
      await page.getByRole('button', { name: 'Change password', exact: true }).click();
      await ui(notice(page, '#panel-security', 'error')).toContainText('do not match');
      // Devices: another session appears with its name, and removal asks first.
      const other = h.client();
      await other.login('account-page-new@example.test', password, 'Pixel phone');
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      const pixel = page.locator('#sessions li').filter({ hasText: 'Pixel phone' });
      await ui(pixel).toBeVisible();
      await ui(pixel).toContainText('Signed in');
      await ui(
        page.locator('#sessions li').filter({ hasText: 'This device' }).first(),
      ).toBeVisible();
      await pixel.getByRole('button', { name: 'Remove Pixel phone' }).click();
      await ui(
        pixel.getByRole('form', { name: /Confirm removing Pixel phone/ }),
      ).toBeVisible();
      await ui(pixel.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await pixel.getByRole('button', { name: 'Cancel' }).click();
      await ui(pixel.getByRole('button', { name: 'Remove Pixel phone' })).toBeVisible();
      await pixel.getByRole('button', { name: 'Remove Pixel phone' }).click();
      await pixel.getByRole('button', { name: 'Remove device' }).click();
      await ui(notice(page, '#panel-devices', 'success')).toContainText(
        'Pixel phone was removed',
      );
      await ui(
        page.locator('#sessions li').filter({ hasText: 'Pixel phone' }),
      ).toHaveCount(0);
      await expect(other.request<unknown>('/me')).rejects.toMatchObject({ status: 401 });
      expect(await page.locator('[style]').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 120000);

  it('explains a lost session, an expired recent sign-in and an unreachable service where they happen', async () => {
    await registerAccount(h, 'recent@example.test');
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await openAccountPage(page, origin);
      await submitSignIn(page, 'recent@example.test', password);
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      // Security changes need a sign-in from the last ten minutes: the page says so and offers it.
      await h.database.query(
        "UPDATE ultra_sessions SET auth_at=auth_at-700000 WHERE account_id=(SELECT id FROM ultra_accounts WHERE email='recent@example.test')",
      );
      await page.getByRole('button', { name: 'Change email' }).click();
      await page.getByLabel('New email address').fill('recent-new@example.test');
      await page.getByRole('button', { name: 'Send verification link' }).click();
      await ui(notice(page, '#panel-account', 'error')).toContainText('sign in again');
      await page.getByRole('button', { name: 'Sign in again' }).click();
      await ui(notice(page, '#login', 'info')).toContainText('Sign in again to continue');
      await ui(page.locator('#dashboard')).toBeHidden();
      // Nothing personal stays on a locked page.
      expect(await page.locator('#who').textContent()).toBe('');
      expect(await page.locator('#account-id').textContent()).toBe('');
      await submitSignIn(page, 'recent@example.test', password);
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      await ui(page.locator('#storage-summary')).not.toHaveText('Loading…');
      // A session ended from another device is reported instead of a blank page.
      await h.database.query(
        "UPDATE ultra_sessions SET revoked=true WHERE account_id=(SELECT id FROM ultra_accounts WHERE email='recent@example.test')",
      );
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      await ui(notice(page, '#login', 'info')).toContainText('Your session ended', {
        timeout: 30000,
      });
      await ui(page.locator('#dashboard')).toBeHidden();
      // An unreachable service opens the cached-account option instead of failing silently.
      const offline = await browser.newContext();
      const offlinePage = await offline.newPage();
      await offlinePage.route('**/api/v2/accounts/capabilities', (route) =>
        route.abort(),
      );
      await offlinePage.goto(origin + '/account');
      await offlinePage.waitForFunction(() => document.body.dataset.ready === 'true');
      await ui(notice(offlinePage, '#login', 'warning')).toContainText('unavailable');
      await ui(offlinePage.locator('#login-advanced')).toHaveAttribute('open', '');
      await offline.close();
    } finally {
      await context.close();
    }
  }, 120000);

  it('manages published calendars without a form: rotate shows the new URL once with a copy button, stop removes the row', async () => {
    await registerAccount(h, 'calendars@example.test');
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    // Publishing happens in the app; the dashboard only lists, rotates and stops feeds.
    const feeds = [
      { id: 'feed-one', label: 'Availability', privacy: 'busy' },
      { id: 'feed-two', label: 'Work plan', privacy: 'titles' },
    ];
    const calls: string[] = [];
    await page.route('**/api/v2/accounts/calendar-feeds**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/api/v2/accounts', '');
      calls.push(request.method() + ' ' + path);
      const json = (body: unknown) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      if (request.method() === 'GET') return json({ feeds });
      if (path.endsWith('/rotate'))
        return json({ url: origin + '/cal/rotated-secret-token.ics' });
      feeds.splice(
        feeds.findIndex((feed) => path.endsWith(feed.id)),
        1,
      );
      return json({ stopped: true });
    });
    try {
      await openAccountPage(page, origin);
      await submitSignIn(page, 'calendars@example.test', password);
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      const section = page.locator('#calendar-publications');
      await ui(
        section.getByRole('heading', { name: 'Published calendars' }),
      ).toBeVisible();
      // The plaintext disclosure stays in full.
      await ui(section).toContainText('readable by the server operator');
      await ui(section).toContainText('anyone with their subscription URL');
      await ui(section).toContainText('Notes stay private');
      await ui(section).toContainText('calendar apps may retain downloaded copies');
      const rows = section.locator('#calendar-feed-list li');
      await ui(rows).toHaveCount(2);
      await ui(rows.first()).toContainText('Availability');
      await ui(rows.first()).toContainText('Busy times only');
      await ui(rows.last()).toContainText('Task titles and times');
      await rows
        .first()
        .getByRole('button', { name: 'Rotate URL for Availability' })
        .click();
      const shown = page.locator('#calendar-feed-url');
      await ui(shown).toContainText('shown only now');
      await ui(shown.locator('code')).toHaveText(
        origin + '/cal/rotated-secret-token.ics',
      );
      await shown.getByRole('button', { name: 'Copy URL' }).click();
      await ui(shown.getByRole('button', { name: 'Copied' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        origin + '/cal/rotated-secret-token.ics',
      );
      await rows
        .last()
        .getByRole('button', { name: 'Stop publishing Work plan' })
        .click();
      await ui(rows).toHaveCount(1);
      await ui(notice(page, '#panel-account', 'success')).toContainText(
        'Previously downloaded copies may remain in calendar apps',
      );
      await ui(shown).toBeEmpty();
      expect(calls).toEqual(
        expect.arrayContaining([
          'GET /calendar-feeds',
          'POST /calendar-feeds/feed-one/rotate',
          'DELETE /calendar-feeds/feed-two',
        ]),
      );
      await rows
        .first()
        .getByRole('button', { name: 'Stop publishing Availability' })
        .click();
      await ui(section.locator('#calendar-feed-list')).toContainText(
        'No calendars published',
      );
    } finally {
      await context.close();
    }
  }, 120000);

  it('hides account creation entirely when the server has closed registration', async () => {
    const closed = await createHarness({ registrationOpen: false });
    const closedOrigin = await serveDashboard(closed);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await openAccountPage(page, closedOrigin, '?view=signup');
      await ui(page.locator('#registration-closed')).toBeVisible();
      await ui(
        page.getByRole('button', { name: 'Create account', exact: true }),
      ).toBeHidden();
      await ui(page.getByText('New to Ultra Tasks?')).toBeHidden();
      await ui(page.locator('#signup')).toBeHidden();
      await ui(page.getByRole('heading', { level: 1 })).toHaveText(
        'Sign in to your Ultra Tasks account',
      );
    } finally {
      await context.close();
      await closed.close();
    }
  }, 60000);

  it('keeps every view inside a 390px screen in light and dark', async () => {
    await registerAccount(h, 'narrow@example.test');
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      const fits = async (name: string) =>
        expect([name, await fitsWidth(page)]).toEqual([name, true]);
      try {
        await openAccountPage(page, origin);
        await fits('sign-in');
        await page.getByText('Advanced', { exact: true }).click();
        await fits('sign-in advanced');
        await page.getByRole('button', { name: 'Create account', exact: true }).click();
        await fits('sign-up');
        const form = page.locator('#signup');
        await form
          .getByLabel('Email', { exact: true })
          .fill('narrow-signup@example.test');
        await form.getByLabel('Password', { exact: true }).fill(password);
        await form.getByLabel('Confirm password').fill(password);
        await page.locator('#signup-consent-accepted').check();
        await form.getByRole('button', { name: 'Continue', exact: true }).click();
        await ui(page.locator('#recovery-sheet')).toBeVisible({ timeout: 20000 });
        await fits('recovery key');
        await page.locator('#saved-key').check();
        await page.locator('#finish-signup button.primary').click();
        await ui(page.locator('#verify-email')).toBeVisible();
        await fits('verify email');
        await page.getByRole('button', { name: 'Back to sign in' }).first().click();
        await page.getByRole('button', { name: 'Forgot password?' }).click();
        await fits('recover');
        await page.getByRole('button', { name: 'Back to sign in' }).click();
        await submitSignIn(page, 'narrow@example.test', password);
        await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
        await fits('account');
        await page.getByRole('button', { name: 'Change email' }).click();
        await fits('account with email form');
        await page.getByRole('button', { name: 'Security', exact: true }).click();
        await page.locator('#password-details > summary').click();
        await page.getByText('Delete my account…', { exact: true }).click();
        await fits('security with forms open');
        await page.getByRole('button', { name: 'Devices', exact: true }).click();
        await page
          .locator('#sessions li')
          .first()
          .getByRole('button', { name: /Remove/ })
          .click();
        await fits('devices with confirmation');
        // Touch targets stay comfortable.
        const small = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('button, a.button, summary'))
            .filter((el) => el.getClientRects().length > 0)
            .filter((el) => el.getBoundingClientRect().height < 32)
            .map((el) => el.textContent?.trim() || el.id),
        );
        expect(small).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 180000);

  it('serves a page with no inline styles and no data: images, as the production policy requires', async () => {
    const html = await (await fetch(origin + '/account')).text();
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    const css = await (await fetch(origin + '/ultra-account.css')).text();
    expect(css).not.toMatch(/url\(\s*['"]?data:/i);
    expect(html).toContain('<title>Sign in – Ultra Tasks account</title>');
    // User-facing copy uses the one product name.
    expect(html).not.toMatch(/UltraSync|UltraTasks Account|Ultra Tasks Account/);
  });
});

describe('new-device email verification in the account website', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    h = await createHarness({ deviceEmailVerification: true });
    origin = await serveDashboard(h);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN,
      headless: true,
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });
  const deviceCode = (email: string) =>
    h.mail.findLast((message) => message.email === email && message.kind === 'device')!
      .token;
  const storedTokens = (page: Page) =>
    page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('ultra-device-token-v1:')),
    );
  // Capture the return to the app instead of launching anything.
  const captureAppReturn = (page: Page) =>
    page.addInitScript(() =>
      document.addEventListener(
        'click',
        (event) => {
          const target =
            event.target instanceof Element ? event.target.closest('a') : null;
          if (target && /^ultratasks:/.test(target.href)) {
            event.preventDefault();
            (window as unknown as { appReturn: string }).appReturn = target.href;
          }
        },
        true,
      ),
    );

  it('verifies a new device by email, remembers it, and does not ask again', async () => {
    await registerAccount(h, 'verify-device@example.test');
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await openAccountPage(page, origin);
      await submitSignIn(page, 'verify-device@example.test', password);
      await ui(page.locator('#device-verify')).toBeVisible({ timeout: 30000 });
      await expect(page.title()).resolves.toBe(
        'Verify this device – Ultra Tasks account',
      );
      await ui(page.getByRole('heading', { level: 1 })).toHaveText('Verify this device');
      await ui(page.locator('#device-verify-hint')).toHaveText('v***@example.test');
      expect(await page.locator('#dashboard').isHidden()).toBe(true);
      // The code field is built for one-time codes and for mobile keyboards.
      const code = page.locator('#device-verify').getByLabel('Verification code');
      await ui(code).toHaveAttribute('inputmode', 'numeric');
      await ui(code).toHaveAttribute('autocomplete', 'one-time-code');
      await ui(code).toBeFocused();
      // No choice to make: the page says plainly that the browser is remembered.
      await ui(page.locator('#device-verify').getByRole('checkbox')).toHaveCount(0);
      await ui(code).toHaveAccessibleDescription(/we remember this browser/i);
      await ui(code).toHaveAccessibleDescription(/remove it from Devices/i);
      // The next code is offered after the server's cooldown, with a visible countdown.
      await ui(page.locator('#device-resend')).toBeDisabled();
      await ui(page.locator('#device-resend')).toHaveText(/Send a new code in \d+s/);
      // A wrong code is explained and keeps the person here.
      await code.fill('00000000');
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await ui(notice(page, '#device-verify', 'error')).toContainText(
        'not right or has expired',
      );
      await ui(code).toHaveAttribute('aria-invalid', 'true');
      await ui(code).toBeFocused();
      expect(await page.locator('#dashboard').isHidden()).toBe(true);
      await code.fill(deviceCode('verify-device@example.test'));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      expect((await storedTokens(page)).length).toBe(1);
      const token = await page.evaluate(() =>
        localStorage.getItem(Object.keys(localStorage)[0]),
      );
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The key is derived from the server origin and a hash of the email, never the email.
      expect((await storedTokens(page))[0]).not.toContain('verify-device');
      // This device is listed as trusted and current.
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      const row = page.locator('#sessions li').first();
      await ui(row).toContainText('This device');
      await ui(row).toContainText('Trusted');
      await ui(page.locator('#devices-trusted-note')).toBeVisible();
      // Signing in again on this browser does not send another email, and the stored token
      // stays: the server newly issues one only for a device it did not recognize.
      const mailBefore = h.mail.length;
      await page.locator('#logout').click();
      await submitSignIn(page, 'verify-device@example.test', password);
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      expect(h.mail.length).toBe(mailBefore);
      expect(
        await page.evaluate(
          (key) => localStorage.getItem(key),
          (await storedTokens(page))[0],
        ),
      ).toBe(token);
      expect(await storedTokens(page)).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120000);

  it('can send a new code after the cooldown, and the verified browser is remembered', async () => {
    await registerAccount(h, 'resend-device@example.test');
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.clock.install();
      await openAccountPage(page, origin);
      await submitSignIn(page, 'resend-device@example.test', password);
      await ui(page.locator('#device-verify')).toBeVisible({ timeout: 30000 });
      const first = deviceCode('resend-device@example.test');
      const sent = h.mail.filter(
        (message) =>
          message.email === 'resend-device@example.test' && message.kind === 'device',
      ).length;
      // Move the page and the server past the 30 second cooldown together.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31000 });
      try {
        await page.clock.fastForward(31000);
        await ui(page.locator('#device-resend')).toBeEnabled();
        await ui(page.locator('#device-resend')).toHaveText('Send a new code');
        await page.locator('#device-resend').click();
        await ui(notice(page, '#device-verify', 'success')).toContainText(
          'sent a new code',
        );
        await ui(page.locator('#device-resend')).toBeDisabled();
      } finally {
        vi.useRealTimers();
      }
      expect(
        h.mail.filter(
          (message) =>
            message.email === 'resend-device@example.test' && message.kind === 'device',
        ),
      ).toHaveLength(sent + 1);
      const second = deviceCode('resend-device@example.test');
      expect(second).not.toBe(first);
      await page.locator('#device-verify').getByLabel('Verification code').fill(second);
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      // The token the server issued is kept whichever code finished the check.
      expect(await storedTokens(page)).toHaveLength(1);
    } finally {
      await context.close();
    }
  }, 120000);

  it('shows a clear message instead of bypassing the check when the page is out of date or mail fails', async () => {
    await registerAccount(h, 'update-device@example.test');
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await openAccountPage(page, origin);
      // An old copy of this page does not declare that it can show the code step.
      await page.route('**/login/finish', async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        delete body.clientFeatures;
        await route.continue({ postData: JSON.stringify(body) });
      });
      await submitSignIn(page, 'update-device@example.test', password);
      await ui(notice(page, '#login', 'error')).toContainText(
        'Update Ultra Tasks to sign in on a new device',
      );
      await ui(page.getByRole('button', { name: 'Reload page' })).toBeVisible();
      expect(await page.locator('#dashboard').isHidden()).toBe(true);
      await page.unroute('**/login/finish');
      // A mail failure leaves the person signed out with an explanation.
      h.failingMail.add('device');
      try {
        await submitSignIn(page, 'update-device@example.test', password);
        await ui(notice(page, '#login', 'error')).toContainText(
          'The verification email could not be sent',
          { timeout: 30000 },
        );
        expect(await page.locator('#dashboard').isHidden()).toBe(true);
      } finally {
        h.failingMail.delete('device');
      }
    } finally {
      await context.close();
    }
  }, 120000);

  it('explains the session limit and the email limits in plain words, on the card where they happen', async () => {
    await registerAccount(h, 'limits-device@example.test');
    const context = await browser.newContext();
    const page = await context.newPage();
    const refuse = (status: number, error: string, code: string) =>
      page.route('**/login/finish', (route) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ error, code }),
        }),
      );
    try {
      await openAccountPage(page, origin);
      // Too many signed-in devices: the way out is named, though Devices is not reachable yet.
      await refuse(
        409,
        'Revoke an old device session before signing in again',
        'session_limit',
      );
      await submitSignIn(page, 'limits-device@example.test', password);
      await ui(noticeText(page, '#login', 'error')).toHaveText(
        'This account has too many signed-in devices. Sign in on a device you already use and remove an old one in Devices.',
      );
      await page.unroute('**/login/finish');
      // Too many verification emails: nothing is sent, nothing is shown but a calm sentence.
      await refuse(
        429,
        'Too many verification emails were requested for this account. Try again later.',
        'verification_rate_limited',
      );
      await submitSignIn(page, 'limits-device@example.test', password);
      await ui(noticeText(page, '#login', 'error')).toContainText(
        'Too many verification emails were requested for this account',
      );
      await page.unroute('**/login/finish');
      expect(await page.locator('#device-verify').isHidden()).toBe(true);
      expect(await page.locator('#dashboard').isHidden()).toBe(true);
      // A mail provider that fails is described without blaming the person.
      h.failingMail.add('device');
      try {
        await submitSignIn(page, 'limits-device@example.test', password);
        await ui(noticeText(page, '#login', 'error')).toContainText(
          'The verification email could not be sent. Try again in a moment.',
          { timeout: 30000 },
        );
        await ui(noticeText(page, '#login', 'error')).toContainText(
          'ask the operator of this server to check its email settings',
        );
      } finally {
        h.failingMail.delete('device');
      }
    } finally {
      await context.close();
    }
  }, 120000);

  it('explains each way a new code can be refused, and returns to sign-in when there is nothing left to verify', async () => {
    await registerAccount(h, 'resend-limits@example.test');
    const context = await browser.newContext();
    const page = await context.newPage();
    const refuse = (status: number, error: string, code?: string) =>
      page.route('**/login/device/resend', (route) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(code ? { error, code } : { error }),
        }),
      );
    // The page's own countdown is moved on; the refusals come from the mock, not the server.
    const reachVerification = async () => {
      await submitSignIn(page, 'resend-limits@example.test', password);
      await ui(page.locator('#device-verify')).toBeVisible({ timeout: 30000 });
      await page.clock.fastForward(31000);
      await ui(page.locator('#device-resend')).toBeEnabled();
    };
    try {
      await page.clock.install();
      await openAccountPage(page, origin);
      await reachVerification();
      // An email budget spent: the person stays, and the code already sent still works.
      await refuse(
        429,
        'Too many verification emails were requested for this account. Try again later.',
        'verification_rate_limited',
      );
      await page.locator('#device-resend').click();
      await ui(noticeText(page, '#device-verify', 'error')).toContainText(
        'Too many verification emails were requested for this account',
      );
      await ui(page.locator('#device-verify')).toBeVisible();
      await page.unroute('**/login/device/resend');
      // Mail could not be sent: the challenge is gone, so the sign-in ends with an explanation.
      await refuse(
        503,
        'Email could not be delivered. Please try again.',
        'email_delivery_failed',
      );
      await page.locator('#device-resend').click();
      await ui(noticeText(page, '#login', 'error')).toContainText(
        'The verification email could not be sent',
      );
      await ui(page.locator('#device-verify')).toBeHidden();
      await page.unroute('**/login/device/resend');
      // No more codes for this sign-in: the server's sentence, and the button stays off.
      await reachVerification();
      await refuse(
        429,
        'No more codes can be sent for this sign-in. Sign in again.',
        'resend_limit',
      );
      await page.locator('#device-resend').click();
      await ui(noticeText(page, '#device-verify', 'error')).toContainText(
        'No more codes can be sent for this sign-in',
      );
      await ui(page.locator('#device-resend')).toBeDisabled();
      await ui(page.locator('#device-resend')).toHaveText(
        'No more codes for this sign-in',
      );
      await page.unroute('**/login/device/resend');
      // An expired or locked challenge: nothing to type a code into, so back to sign-in.
      await page.locator('#device-cancel').click();
      await reachVerification();
      await refuse(401, 'Invalid or expired credentials');
      await page.locator('#device-resend').click();
      await ui(noticeText(page, '#login', 'info')).toContainText(
        'expired or was locked after too many wrong codes',
      );
      await ui(page.locator('#device-verify')).toBeHidden();
    } finally {
      await context.close();
    }
  }, 180000);

  it('asks for the new-device check again when an approval is refused, then lets the approval go through', async () => {
    await registerAccount(h, 'reapprove@example.test');
    const native = new AccountClient(httpTransport(origin));
    const flow = await native.startBrowserLogin(
      origin,
      'ultratasks://account-login',
      'My tablet app',
    );
    const context = await browser.newContext();
    const page = await context.newPage();
    await captureAppReturn(page);
    try {
      await page.goto(await browserLoginUrl(flow.request));
      await submitSignIn(page, 'reapprove@example.test', password);
      await ui(page.locator('#device-verify')).toBeVisible({ timeout: 30000 });
      await page
        .locator('#device-verify')
        .getByLabel('Verification code')
        .fill(deviceCode('reapprove@example.test'));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await ui(page.locator('#app-login-approval')).toBeVisible({ timeout: 30000 });
      // The session loses its device (as after a removal): the server refuses the approval.
      await h.database.query(
        "UPDATE ultra_sessions SET device_id=NULL WHERE account_id=(SELECT id FROM ultra_accounts WHERE email='reapprove@example.test')",
      );
      await page.locator('#app-login-approve').click();
      const refusal = notice(page, '#app-login-approval', 'error');
      await ui(refusal).toContainText('has not finished its new-device check');
      await ui(refusal).toContainText('enter the emailed code if asked');
      await ui(refusal).toContainText('approve the app request again');
      expect(await page.locator('#app-login-finished').isHidden()).toBe(true);
      await refusal.getByRole('button', { name: 'Sign in again' }).click();
      // Back at sign-in, with the request still described and the way forward spelled out.
      await ui(page.locator('#login')).toBeVisible();
      await ui(noticeText(page, '#login', 'info')).toContainText(
        'finish the new-device check, then approve the app request again',
      );
      await ui(page.locator('#app-login-context')).toContainText('My tablet app');
      // This browser was remembered, so signing in needs no code and lands on the approval.
      const mailBefore = h.mail.length;
      await submitSignIn(page, 'reapprove@example.test', password);
      await ui(page.locator('#app-login-approval')).toBeVisible({ timeout: 30000 });
      expect(h.mail.length).toBe(mailBefore);
      await page.locator('#app-login-approve').click();
      await ui(page.locator('#app-login-finished')).toBeVisible();
      expect(await native.pollBrowserLogin()).toBe(true);
      expect(native.account?.email).toBe('reapprove@example.test');
    } finally {
      await context.close();
    }
  }, 120000);

  it('approves an app sign-in from a session that passed the new-device check, asking for nothing more', async () => {
    await registerAccount(h, 'approve-device@example.test');
    const native = new AccountClient(httpTransport(origin));
    const flow = await native.startBrowserLogin(
      origin,
      'ultratasks://account-login',
      'My laptop app',
    );
    const context = await browser.newContext();
    const page = await context.newPage();
    await captureAppReturn(page);
    try {
      await page.goto(await browserLoginUrl(flow.request));
      await ui(page.locator('#app-login-context')).toBeVisible();
      await submitSignIn(page, 'approve-device@example.test', password);
      // The new device is verified first; the request stays described while that happens.
      await ui(page.locator('#device-verify')).toBeVisible({ timeout: 30000 });
      await ui(page.locator('#app-login-context')).toBeVisible();
      await ui(page.locator('#app-login-context')).toContainText('My laptop app');
      await page
        .locator('#device-verify')
        .getByLabel('Verification code')
        .fill(deviceCode('approve-device@example.test'));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      // Nothing more is asked: the approval is the next and last step.
      await ui(page.locator('#app-login-approval')).toBeVisible({ timeout: 30000 });
      await ui(page.getByRole('heading', { level: 1 })).toHaveText('Connect your app');
      await page.locator('#app-login-approve').click();
      await ui(page.locator('#app-login-finished')).toBeVisible();
      expect(
        await page.evaluate(() => (window as unknown as { appReturn: string }).appReturn),
      ).toContain('ultratasks://account-login');
      expect(await native.pollBrowserLogin()).toBe(true);
      expect(native.account?.email).toBe('approve-device@example.test');
      // The approving session satisfied the policy, so the app is trusted too.
      expect(native.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      await context.close();
    }
  }, 120000);

  it('lets the person turn the new-device check off after a warning, and a stolen password then needs nothing more', async () => {
    await registerAccount(h, 'toggle-device@example.test');
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await openAccountPage(page, origin);
      await submitSignIn(page, 'toggle-device@example.test', password);
      // Wait for this browser's own challenge before reading the code that was mailed.
      await ui(page.locator('#device-verify')).toBeVisible({ timeout: 30000 });
      await page
        .locator('#device-verify')
        .getByLabel('Verification code')
        .fill(deviceCode('toggle-device@example.test'));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      await page.getByRole('button', { name: 'Security', exact: true }).click();
      const toggle = page.getByRole('switch', { name: 'New-device email verification' });
      await ui(toggle).toBeVisible();
      await ui(toggle).toHaveAttribute('aria-checked', 'true');
      await ui(toggle).toHaveAccessibleDescription(/8-digit code/);
      // Turning protection off is a warned, confirmed step; cancelling changes nothing.
      await toggle.click();
      await ui(page.locator('#new-device-confirm')).toContainText(
        'Anyone who knows your password will be able to sign in on a new device without an email code',
      );
      await page.getByRole('button', { name: 'Cancel' }).first().click();
      await ui(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click();
      await page.getByRole('button', { name: 'Turn off' }).click();
      await ui(notice(page, '#panel-security', 'warning')).toContainText(
        'New-device email verification is off',
      );
      await ui(toggle).toHaveAttribute('aria-checked', 'false');
      expect(
        (
          await h.database.query<{ new_device_email: boolean }>(
            "SELECT new_device_email FROM ultra_accounts WHERE email='toggle-device@example.test'",
          )
        ).rows[0].new_device_email,
      ).toBe(false);
      // A new browser now signs in with the password alone.
      const fresh = await browser.newContext();
      const freshPage = await fresh.newPage();
      await openAccountPage(freshPage, origin);
      await submitSignIn(freshPage, 'toggle-device@example.test', password);
      await ui(freshPage.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      await fresh.close();
      // Turning it back on needs no confirmation step.
      await toggle.click();
      await ui(notice(page, '#panel-security', 'success')).toContainText('is on');
      await ui(toggle).toHaveAttribute('aria-checked', 'true');
    } finally {
      await context.close();
    }
  }, 120000);
});

/**
 * Removing devices has its own harness: every route allows 30 requests per address and 15
 * minutes, and the sign-ins of the describe above already use most of that from loopback.
 */
describe('removing devices in the account website', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    h = await createHarness({ deviceEmailVerification: true });
    origin = await serveDashboard(h);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN,
      headless: true,
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });
  const deviceCode = (email: string) =>
    h.mail.findLast((message) => message.email === email && message.kind === 'device')!
      .token;

  /** A trusted device that signed in through the account's second factor (a recovery code). */
  const signInThroughFactor = async (email: string, name: string, code: string) => {
    const other = h.client();
    expect((await other.login(email, password, name)).mfaToken).toBeTruthy();
    await other.completeMfa(code);
    return other;
  };
  const recoveryLeft = async (email: string) =>
    (
      await h.database.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM ultra_recovery_codes WHERE account_id=(SELECT id FROM ultra_accounts WHERE email=$1)',
        [email],
      )
    ).rows[0].n;
  const otherRows = (page: Page) =>
    page
      .locator('#sessions li')
      .filter({ hasNot: page.locator('.badge', { hasText: 'This device' }) });

  it('asks an account with a second factor for a code before removing another device', async () => {
    const email = 'factor-devices@example.test';
    const owner = await registerAccount(h, email);
    const enrollment = await owner.request<{ secret: string; enrollmentToken: string }>(
      '/factors/totp/start',
      {},
    );
    const { recoveryCodes } = await owner.request<{ recoveryCodes: string[] }>(
      '/factors/totp/finish',
      { enrollmentToken: enrollment.enrollmentToken, code: totp(enrollment.secret) },
    );
    const phone = await signInThroughFactor(email, 'Pixel phone', recoveryCodes[0]);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await openAccountPage(page, origin);
      await submitSignIn(page, email, password);
      await ui(page.locator('#mfa')).toBeVisible({ timeout: 30000 });
      await page.locator('#mfa-code').fill(recoveryCodes[1]);
      await page.locator('#mfa button.primary').click();
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      const pixel = page.locator('#sessions li').filter({ hasText: 'Pixel phone' });
      await pixel.getByRole('button', { name: 'Remove Pixel phone' }).click();
      const form = pixel.getByRole('form', { name: /Confirm removing Pixel phone/ });
      const code = form.getByLabel('Authenticator or recovery code');
      await ui(code).toBeFocused();
      await ui(code).toHaveAttribute('autocomplete', 'one-time-code');
      // An authenticator is enrolled, so there is no "recovery code only" hint.
      await ui(form).not.toContainText('Use a recovery code');
      // Nothing is sent without a code.
      await form.getByRole('button', { name: 'Remove device' }).click();
      expect(
        await code.evaluate((box) => (box as HTMLInputElement).validity.valueMissing),
      ).toBe(true);
      // A wrong code is said plainly, keeps the session and the device, and spends nothing.
      await code.fill('not a valid code');
      await form.getByRole('button', { name: 'Remove device' }).click();
      await ui(noticeText(page, '#panel-devices', 'error')).toHaveText(
        'That code did not work.',
      );
      await ui(code).toHaveAttribute('aria-invalid', 'true');
      await ui(code).toHaveValue('');
      await ui(page.locator('#dashboard')).toBeVisible();
      await expect(phone.request<unknown>('/me')).resolves.toBeTruthy();
      expect(await recoveryLeft(email)).toBe(8);
      // A recovery code removes the device; it is used up.
      await code.fill(recoveryCodes[2]);
      await form.getByRole('button', { name: 'Remove device' }).click();
      await ui(noticeText(page, '#panel-devices', 'success')).toHaveText(
        'Pixel phone was removed.',
      );
      await ui(
        page.locator('#sessions li').filter({ hasText: 'Pixel phone' }),
      ).toHaveCount(0);
      await expect(phone.request<unknown>('/me')).rejects.toMatchObject({ status: 401 });
      expect(await recoveryLeft(email)).toBe(7);
      // An authenticator code works as well: the owner's first device is next.
      const next = otherRows(page).first();
      await next.getByRole('button', { name: /^Remove / }).click();
      await next
        .getByLabel('Authenticator or recovery code')
        .fill(totp(enrollment.secret, Math.floor(Date.now() / 30000) + 1));
      await next.getByRole('button', { name: 'Remove device' }).click();
      await ui(noticeText(page, '#panel-devices', 'success')).toContainText(
        'was removed',
      );
      await expect(owner.request<unknown>('/me')).rejects.toMatchObject({ status: 401 });
      await ui(otherRows(page)).toHaveCount(0);
      // This browser's own device needs no code at all, and signs this browser out.
      const mine = page
        .locator('#sessions li')
        .filter({ has: page.locator('.badge', { hasText: 'This device' }) });
      await mine.getByRole('button', { name: /^Remove / }).click();
      const own = mine.getByRole('form', { name: /Confirm removing/ });
      await ui(own.getByLabel('Authenticator or recovery code')).toHaveCount(0);
      await own.getByRole('button', { name: 'Remove device' }).click();
      await ui(noticeText(page, '#login', 'info')).toContainText(
        'This browser was removed from your devices',
      );
      await ui(page.locator('#dashboard')).toBeHidden();
    } finally {
      await context.close();
    }
  }, 180000);

  it('explains a stale sign-in before removing another device, without using up the code', async () => {
    const email = 'stale-devices@example.test';
    const owner = await registerAccount(h, email);
    const enrollment = await owner.request<{ secret: string; enrollmentToken: string }>(
      '/factors/totp/start',
      {},
    );
    const { recoveryCodes } = await owner.request<{ recoveryCodes: string[] }>(
      '/factors/totp/finish',
      { enrollmentToken: enrollment.enrollmentToken, code: totp(enrollment.secret) },
    );
    const phone = await signInThroughFactor(email, 'Pixel phone', recoveryCodes[0]);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await openAccountPage(page, origin);
      await submitSignIn(page, email, password);
      await ui(page.locator('#mfa')).toBeVisible({ timeout: 30000 });
      await page.locator('#mfa-code').fill(recoveryCodes[1]);
      await page.locator('#mfa button.primary').click();
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      await ui(page.locator('#storage-summary')).not.toHaveText('Loading…');
      // Ten minutes after signing in, security changes need a fresh sign-in.
      await h.database.query(
        'UPDATE ultra_sessions SET auth_at=auth_at-700000 WHERE account_id=(SELECT id FROM ultra_accounts WHERE email=$1)',
        [email],
      );
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      const pixel = page.locator('#sessions li').filter({ hasText: 'Pixel phone' });
      await pixel.getByRole('button', { name: 'Remove Pixel phone' }).click();
      await pixel.getByLabel('Authenticator or recovery code').fill(recoveryCodes[2]);
      await pixel.getByRole('button', { name: 'Remove device' }).click();
      const stale = notice(page, '#panel-devices', 'error');
      await ui(stale).toContainText(
        'For your security, sign in again before removing another device.',
      );
      await ui(stale.getByRole('button', { name: 'Sign in again' })).toBeVisible();
      // The refusal came first: the device is still signed in and the code is still good.
      await expect(phone.request<unknown>('/me')).resolves.toBeTruthy();
      expect(await recoveryLeft(email)).toBe(8);
      await stale.getByRole('button', { name: 'Sign in again' }).click();
      await ui(noticeText(page, '#login', 'info')).toHaveText(
        'Sign in again to remove devices.',
      );
      await ui(page.locator('#dashboard')).toBeHidden();
      expect(await page.locator('#login-password').inputValue()).toBe('');
    } finally {
      await context.close();
    }
  }, 180000);

  it('removes another device with the confirmation alone when no second factor is enrolled', async () => {
    const email = 'plain-devices@example.test';
    await registerAccount(h, email);
    const tablet = h.client();
    expect((await tablet.login(email, password, 'Tablet')).verification).toBeTruthy();
    await tablet.completeDeviceVerification(deviceCode(email));
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await openAccountPage(page, origin);
      await submitSignIn(page, email, password);
      await ui(page.locator('#device-verify')).toBeVisible({ timeout: 30000 });
      await page
        .locator('#device-verify')
        .getByLabel('Verification code')
        .fill(deviceCode(email));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      const row = page.locator('#sessions li').filter({ hasText: 'Tablet' });
      await row.getByRole('button', { name: 'Remove Tablet' }).click();
      const form = row.getByRole('form', { name: /Confirm removing Tablet/ });
      await ui(form.getByLabel('Authenticator or recovery code')).toHaveCount(0);
      await ui(form.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await form.getByRole('button', { name: 'Remove device' }).click();
      await ui(noticeText(page, '#panel-devices', 'success')).toHaveText(
        'Tablet was removed.',
      );
      await expect(tablet.request<unknown>('/me')).rejects.toMatchObject({ status: 401 });
      // With no code to get wrong, a refusal can only mean this session itself has ended.
      const laptop = h.client();
      expect((await laptop.login(email, password, 'Laptop')).verification).toBeTruthy();
      await laptop.completeDeviceVerification(deviceCode(email));
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      const laptopRow = page.locator('#sessions li').filter({ hasText: 'Laptop' });
      await laptopRow.getByRole('button', { name: 'Remove Laptop' }).click();
      await h.database.query(
        'UPDATE ultra_sessions SET revoked=true WHERE account_id=(SELECT id FROM ultra_accounts WHERE email=$1) AND device_name<>$2',
        [email, 'Laptop'],
      );
      await laptopRow.getByRole('button', { name: 'Remove device' }).click();
      await ui(noticeText(page, '#login', 'info')).toContainText('Your session ended');
      await ui(page.locator('#dashboard')).toBeHidden();
      await expect(laptop.request<unknown>('/me')).resolves.toBeTruthy();
    } finally {
      await context.close();
    }
  }, 120000);

  it('tells an account with security keys only to use a recovery code to remove another device', async () => {
    const email = 'keys-only-devices@example.test';
    await registerAccount(h, email);
    const context = await browser.newContext();
    const page = await context.newPage();
    await virtualAuthenticator(context, page);
    try {
      await openAccountPage(page, origin);
      await submitSignIn(page, email, password);
      await ui(page.locator('#device-verify')).toBeVisible({ timeout: 30000 });
      await page
        .locator('#device-verify')
        .getByLabel('Verification code')
        .fill(deviceCode(email));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await ui(page.locator('#dashboard')).toBeVisible({ timeout: 30000 });
      await page.getByRole('button', { name: 'Security', exact: true }).click();
      await page.locator('#webauthn-enroll').click();
      await ui(page.locator('#recovery-sheet')).toBeVisible({ timeout: 20000 });
      const codes = (await page.locator('#recovery-material').textContent())!.split('\n');
      await page.locator('#saved-codes').check();
      await page.locator('#finish-codes button.primary').click();
      await ui(page.locator('#panel-security')).toBeVisible();
      const phone = await signInThroughFactor(email, 'Pixel phone', codes[0]);
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      const pixel = page.locator('#sessions li').filter({ hasText: 'Pixel phone' });
      await pixel.getByRole('button', { name: 'Remove Pixel phone' }).click();
      const form = pixel.getByRole('form', { name: /Confirm removing Pixel phone/ });
      // The server takes only an authenticator or recovery code here, never a security key.
      await ui(form).toContainText('Use a recovery code to remove another device.');
      await ui(
        form.getByLabel('Authenticator or recovery code'),
      ).toHaveAccessibleDescription('Use a recovery code to remove another device.');
      await form.getByLabel('Authenticator or recovery code').fill(codes[1]);
      await form.getByRole('button', { name: 'Remove device' }).click();
      await ui(noticeText(page, '#panel-devices', 'success')).toHaveText(
        'Pixel phone was removed.',
      );
      await expect(phone.request<unknown>('/me')).rejects.toMatchObject({ status: 401 });
    } finally {
      await context.close();
    }
  }, 180000);
});
