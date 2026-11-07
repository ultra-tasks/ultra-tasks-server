import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, Browser } from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomKey } from '@ultra-tasks/account-crypto';
import { createHarness, password } from './ultra-account.helper';

describe('encrypted account portal in Chromium with a real virtual WebAuthn authenticator', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    h = await createHarness();
    await h.app.register(fastifyStatic, {
      root: fileURLToPath(new URL('../public', import.meta.url)),
    });
    h.app.get('/account', (_, reply) =>
      reply
        .header('Referrer-Policy', 'no-referrer')
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )
        .sendFile('ultra-account.html'),
    );
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('No browser test address');
    origin = 'http://localhost:' + address.port;
    h.config.publicUrl = origin;
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
      await page.goto(origin + '/account');
      await page.locator('#status').filter({ hasText: 'Ready.' }).waitFor();
      await page.locator('#login-id').fill('deletedashboard');
      await page.locator('#login-password').fill(password);
      await page.locator('#login button:not([type])').click();
      await page.locator('#status').filter({ hasText: 'Signed in.' }).waitFor();
      await page.getByText('Delete account', { exact: true }).click();
      await page.locator('#delete-confirm-email').fill('delete-dashboard@example.test');
      await page.locator('#delete-confirm').check();
      await page.getByRole('button', { name: 'Permanently delete account' }).click();
      await page
        .locator('#status')
        .filter({ hasText: 'Account and personal encrypted server data deleted.' })
        .waitFor();
      await expect(h.client().login('deletedashboard', password)).rejects.toThrow();
    } finally {
      await context.close();
    }
  }, 60000);
  it('registers with saved recovery material, verifies email, uses WebAuthn 2FA, recovers the password, and unlocks offline', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
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
    const wait = (text: string) =>
      page
        .locator('#status')
        .filter({ hasText: text })
        .waitFor({ state: 'visible', timeout: 20000 });
    await page.goto(origin + '/account');
    await wait('Ready.');
    await page.locator('#signup-email').fill('browser@example.test');
    await page.locator('#signup-username').fill('browseruser');
    await page.locator('#signup-password').fill(password);
    await page.locator('#signup-confirm').fill(password);
    await page.locator('#signup button').click();
    await wait('Save or print');
    const recoveryKey = (await page.locator('#recovery-material').textContent())!;
    expect(recoveryKey).toMatch(/^UTRK1-/);
    expect(await page.locator('#recovery-sheet').textContent()).toContain(
      'lose access to your encrypted data',
    );
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download-recovery').click();
    const download = await downloadPromise;
    const saved = await readFile((await download.path())!, 'utf8');
    expect(saved).toContain(recoveryKey);
    expect(saved).toContain('cannot decrypt data');
    await page.locator('#saved-key').check();
    await page.locator('#finish-signup button').click();
    await wait('Check your email');
    await page
      .locator('#verify-token')
      .fill(h.mail.findLast((message) => message.kind === 'verify')!.token);
    await page.locator('#verify-email button').click();
    await wait('Email verified');
    await page.locator('#login-id').fill('browseruser');
    await page.locator('#login-password').fill(password);
    await page.locator('#login button[type=submit], #login button:not([type])').click();
    await wait('Signed in.');
    expect(await page.locator('#personal-state').textContent()).toBe(
      'No data linked yet',
    );
    expect(await page.locator('#server-address').textContent()).toBe(origin);
    await page.screenshot({
      path: fileURLToPath(
        new URL('../../../.tmp/account-dashboard.png', import.meta.url),
      ),
      fullPage: true,
    });
    await page.locator('#webauthn-enroll').click();
    await wait('Signed in.');
    const mfaCodes = (await page.locator('#recovery-material').textContent())!.split(
      '\n',
    );
    expect(mfaCodes).toHaveLength(10);
    expect(mfaCodes[0]).toMatch(/^UTMFA-/);
    await page.locator('#logout').click();
    await wait('Account locked');
    await page.locator('#login-id').fill('browseruser');
    await page.locator('#login-password').fill(password);
    await page.locator('#login button:not([type])').click();
    await wait('Complete two-factor');
    await page.locator('#webauthn-login').click();
    await wait('Signed in.');
    expect(await page.locator('#factors').textContent()).toContain('webauthn');
    await page.locator('#logout').click();
    await wait('Account locked');
    await page.locator('#recover-id').fill('browseruser');
    await page.locator('#recover-request button').click();
    await wait('check your email');
    const mailToken = h.mail.findLast((message) => message.kind === 'recover')!.token;
    await page.goto(origin + '/account?recover=' + mailToken);
    await wait('Ready.');
    expect(page.url()).toBe(origin + '/account');
    await page.locator('#recover-key').fill(recoveryKey);
    await page.locator('#recover-password').fill('a recovered browser password');
    await page.locator('#recover-password-confirm').fill('a recovered browser password');
    await page.locator('#recover-mfa').fill(mfaCodes[0]);
    await page.locator('#recover-finish button').click();
    await wait('Password recovered');
    await page.locator('#login-id').fill('browseruser');
    await page.locator('#login-password').fill('a recovered browser password');
    await page.locator('#login button:not([type])').click();
    await wait('Complete two-factor');
    await page.locator('#webauthn-login').click();
    await wait('Signed in.');
    const storage = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open('ultra-account-v2');
        request.onsuccess = () => resolve(request.result);
      });
      const records = await new Promise<unknown>((resolve) => {
        const request = db.transaction('profiles').objectStore('profiles').getAll();
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return JSON.stringify(records);
    });
    expect(storage).not.toContain(password);
    expect(storage).not.toContain('a recovered browser password');
    expect(storage).not.toContain(recoveryKey);
    await page.locator('#lock').click();
    await wait('Account locked');
    await context.setOffline(true);
    await page.locator('#login-id').fill('browseruser');
    await page.locator('#login-password').fill('a recovered browser password');
    await page.locator('#offline-unlock').click();
    await wait('unlocked offline');
    expect(errors).toEqual([]);
    await context.close();
  });
  it('approves a native or custom-origin login on the server origin and requires the device-only proof to redeem it', async () => {
    const registered = await h.register('nativepasskey@example.test', 'nativepasskey');
    const context = await browser.newContext();
    const page = await context.newPage();
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
    await page.goto(origin + '/account');
    await page.locator('#login-id').fill('nativepasskey');
    await page.locator('#login-password').fill(password);
    await page.locator('#login button:not([type])').click();
    await expect
      .poll(() => page.locator('#status').textContent())
      .toContain('Signed in.');
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
    await page.locator('#device-approve').click();
    await expect
      .poll(() => page.locator('#status').textContent())
      .toContain('Device login approved');
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
