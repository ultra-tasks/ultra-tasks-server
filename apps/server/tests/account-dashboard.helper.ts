import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { password, type createHarness } from './ultra-account.helper';

type Harness = Awaited<ReturnType<typeof createHarness>>;

/** The policy the production server sends with the dashboard page. */
export const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/** The same policy on a server configured with the Cloudflare Turnstile security check. */
export const TURNSTILE_CSP = DASHBOARD_CSP.replace(
  "script-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
).replace(
  "default-src 'self'",
  "default-src 'self'; frame-src 'self' https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com",
);

/**
 * Serves the installed dashboard (built by `npm run build:dashboard`) on a harness with
 * the same headers production uses, so an inline style or a data: image fails the test.
 */
export const serveDashboard = async (
  h: Harness,
  host = 'localhost',
  policy = DASHBOARD_CSP,
): Promise<string> => {
  await h.app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
  });
  h.app.get('/account', (_, reply) =>
    reply
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', policy)
      .sendFile('ultra-account.html'),
  );
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address();
  if (!address || typeof address === 'string') throw new Error('No dashboard address');
  const origin = `http://${host}:${address.port}`;
  h.config.publicUrl = origin;
  return origin;
};

/** Opens the page and waits until its encryption module has started. */
export const openAccountPage = async (
  page: Page,
  origin: string,
  query = '',
): Promise<void> => {
  await page.goto(origin + '/account' + query);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
    timeout: 30000,
  });
};

/** Fills the sign-in form by its labels, as a person would, and submits it. */
export const submitSignIn = async (
  page: Page,
  email: string,
  secret: string,
): Promise<void> => {
  const form = page.locator('#login');
  await form.getByLabel('Email', { exact: true }).fill(email);
  await form.getByLabel('Password', { exact: true }).fill(secret);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
};

/** True when nothing on the page forces a horizontal scrollbar. */
export const fitsWidth = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Everything a flow wrote to the profile cache, as text, to check secrets stay out of it. */
export const cachedProfiles = (page: Page): Promise<string> =>
  page.evaluate(async () => {
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

/**
 * Registers and signs in an account the way the website now does: email and password only
 * (no username, no display name), with the privacy consent a server may require. Works with
 * and without new-device verification; the returned client is already signed in.
 */
export const registerAccount = async (h: Harness, email: string) => {
  const client = h.client();
  const prepared = await client.prepareRegistration(
    { email, termsAccepted: true },
    password,
  );
  await client.register(prepared);
  const code = h.mail.findLast(
    (message) => message.email === email && message.kind === 'verify',
  )!.token;
  await h.transport('/verify-email', { identifier: email, code });
  const result = await client.login(email, password);
  if (result.verification)
    await client.completeDeviceVerification(
      h.mail.findLast((message) => message.email === email && message.kind === 'device')!
        .token,
    );
  return client;
};
