import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import { createHarness, password } from './ultra-account.helper';
import { selectAppAccountServer } from './app-account-ui.helper';

describe('native sync and sharing through the Angular app in Chromium', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    h = await createHarness();
    const clientDist = process.env.ULTRA_CLIENT_DIST;
    if (!clientDist)
      throw new Error('ULTRA_CLIENT_DIST must point to the built client browser bundle');
    await h.app.register(fastifyStatic, {
      root: resolve(clientDist),
    });
    h.app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html'),
    );
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No app address');
    origin = 'http://localhost:' + address.port;
    h.config.publicUrl = origin;
    await h.register();
    const bob = await h.register('bob@example.test', 'bobby');
    await bob.client.changePassword('bob has a different password for this project');
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN,
      headless: true,
      args: ['--no-sandbox'],
    });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });
  const pageFor = async (context: BrowserContext) => {
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('SUP_ONBOARDING_PRESET_DONE', 'true');
      localStorage.setItem('SUP_ONBOARDING_HINTS_DONE', 'true');
      localStorage.setItem('SUP_IS_SHOW_TOUR', 'true');
      localStorage.setItem('SUP_EXAMPLE_TASKS_CREATED', 'true');
    });
    page.on('pageerror', (error) =>
      process.stderr.write('Native browser error: ' + error.message + '\n'),
    );
    page.on('dialog', (dialog) => {
      void dialog.dismiss();
    });
    await page.goto(origin + '/#/native-sync');
    return page;
  };
  const login = async (page: Page, username: string, pw: string, migrate = true) => {
    try {
      await selectAppAccountServer(page, origin);
    } catch (error) {
      process.stderr.write(
        'Native browser URL: ' +
          page.url() +
          '\n' +
          (await page.locator('body').innerText()).slice(0, 5000) +
          '\n',
      );
      throw error;
    }
    await page.getByLabel('Email or username').fill(username);
    await page.getByLabel('Password', { exact: true }).fill(pw);
    await page.getByRole('button', { name: 'Sign in and unlock' }).click();
    if (!migrate) {
      await page
        .getByText('Connect personal data', { exact: true })
        .waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: 'Use the account’s existing data' }).click();
    }
    await page.waitForFunction(
      () =>
        !!document.querySelector('native-sync [role=alert]') ||
        [...document.querySelectorAll('h2')].some((el) =>
          el.textContent?.includes('Shared projects'),
        ),
    );
    const alertNode = page.locator('native-sync [role=alert]');
    const alert = (await alertNode.count()) ? await alertNode.textContent() : null;
    if (alert) throw new Error('Native migration failed: ' + alert);
    await page
      .getByRole('heading', { name: 'Shared projects' })
      .waitFor({ timeout: 30000 });
  };
  it('imports personal data, shares across accounts, keeps private overlays separate, and resumes offline edits', async () => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await pageFor(aliceContext);
    const bob = await pageFor(bobContext);
    await login(alice, 'alice', password);
    await login(bob, 'bobby', 'bob has a different password for this project');
    await alice
      .getByLabel('Project title', { exact: true })
      .fill('Native shared project');
    await alice
      .getByRole('button', { name: 'Create shared project', exact: true })
      .click();
    await alice.getByLabel('New shared task').fill('Encrypted shared task');
    await alice.getByRole('button', { name: 'Add task', exact: true }).click();
    await alice.getByRole('button', { name: 'Sync now', exact: true }).click();
    await alice.getByLabel('Invite by email or username').fill('bobby');
    await alice.getByRole('button', { name: 'Invite', exact: true }).click();
    await alice.getByText('Invitation created.', { exact: false }).waitFor();
    await bob.getByRole('button', { name: 'Sync now', exact: true }).click();
    await bob.getByRole('button', { name: 'Accept invitation' }).click();
    await bob.getByLabel('Encrypted shared task', { exact: true }).waitFor();
    await alice.getByText('Project recovery and deletion', { exact: true }).click();
    await alice.getByRole('button', { name: 'Save restore point', exact: true }).click();
    await bob.getByText('Task details and my private plan', { exact: true }).click();
    const editedAt = performance.now();
    await bob
      .getByLabel('Shared title', { exact: true })
      .fill('Delivered without Sync now');
    await bob.getByRole('heading', { name: 'Native shared project' }).click();
    await alice.getByLabel('Delivered without Sync now', { exact: true }).waitFor();
    expect(performance.now() - editedAt).toBeLessThan(1000);
    await alice.getByRole('button', { name: /^Restore version/ }).click();
    await alice.locator('[e2e=confirmBtn]').click();
    await alice.getByLabel('Encrypted shared task', { exact: true }).waitFor();
    await bob.getByLabel('Encrypted shared task', { exact: true }).waitFor();
    if (!(await bob.getByLabel('My planned day (private)').isVisible()))
      await bob.getByText('Task details and my private plan', { exact: true }).click();
    await bob.getByLabel('My planned day (private)').fill('2026-11-06');
    await bob.getByLabel('My scratch notes (private)').fill('Bobby private planning');
    await bob.getByRole('heading', { name: 'Native shared project' }).click();
    const overlayWrites = await h.db.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT count(*) AS count FROM ultra_record_heads h JOIN ultra_scopes s ON s.id=h.scope_id JOIN ultra_accounts a ON a.id=s.owner_id WHERE a.email='bob@example.test' AND s.kind='personal' AND h.write->'record'->'header'->>'entityType'='personal.overlay'`,
    );
    expect(Number(overlayWrites[0].count)).toBe(0);
    await alice.getByText('Task details and my private plan', { exact: true }).click();
    expect(await alice.getByLabel('My planned day (private)').inputValue()).toBe('');
    expect(await alice.getByLabel('My scratch notes (private)').inputValue()).toBe('');
    await bobContext.setOffline(true);
    await bob
      .getByLabel('Shared description')
      .fill('Offline description survives restart');
    await bob.getByRole('heading', { name: 'Native shared project' }).click();
    await expect
      .poll(() => bob.getByRole('button', { name: 'Sync now', exact: true }).isEnabled())
      .toBe(true);
    await bob.route('**/api/v2/accounts/**', (route) =>
      route.abort('internetdisconnected'),
    );
    await bobContext.setOffline(false);
    await bob.reload();
    await bob.getByLabel('Email or username').fill('bobby');
    await bob
      .getByLabel('Password', { exact: true })
      .fill('bob has a different password for this project');
    await bob.getByRole('button', { name: 'Sign in and unlock' }).click();
    await bob
      .getByRole('heading', { name: 'Shared projects' })
      .waitFor({ timeout: 30000 });
    await bob.getByRole('button', { name: 'Native shared project', exact: true }).click();
    await bob.getByText('Task details and my private plan', { exact: true }).click();
    expect(await bob.getByLabel('Shared description').inputValue()).toBe(
      'Offline description survives restart',
    );
    await bob.unroute('**/api/v2/accounts/**');
    await bobContext.setOffline(true);
    await bobContext.setOffline(false);
    await expect
      .poll(
        () => bob.getByRole('button', { name: 'Sync now', exact: true }).isEnabled(),
        { timeout: 30000 },
      )
      .toBe(true);
    await expect
      .poll(() => alice.getByLabel('Shared description').inputValue(), { timeout: 20000 })
      .toBe('Offline description survives restart');
    await alice.getByRole('button', { name: 'Remove member' }).click();
    await expect
      .poll(() => alice.getByRole('button', { name: 'Remove member' }).count(), {
        timeout: 20000,
      })
      .toBe(0);
    const slow = (
      await h.db.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM ultra_scopes WHERE kind='project'`,
      )
    )[0].id;
    await alice.getByLabel('Project title', { exact: true }).fill('Independent project');
    await alice
      .getByRole('button', { name: 'Create shared project', exact: true })
      .click();
    const fast = (
      await h.db.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM ultra_scopes WHERE kind='project' AND id<>${slow}`,
      )
    )[0].id;
    let release: () => void = () => undefined;
    let intercepted: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    const pattern = '**/api/v2/accounts/sync/scopes/' + slow + '/changes*';
    await alice.route(pattern, async (route) => {
      intercepted();
      await held;
      await route.continue();
    });
    try {
      await alice.getByRole('button', { name: 'Sync now', exact: true }).click();
      await started;
      await alice.getByLabel('New shared task').fill('Saved while another project waits');
      await alice.getByRole('button', { name: 'Add task', exact: true }).click();
      await expect
        .poll(
          async () =>
            Number(
              (
                await h.db.$queryRaw<{ count: bigint }[]>(
                  Prisma.sql`SELECT count(*) AS count FROM ultra_record_heads WHERE scope_id=${fast}`,
                )
              )[0].count,
            ),
          { timeout: 2000 },
        )
        .toBe(2);
    } finally {
      release();
      await alice.unrouteAll({ behavior: 'wait' });
    }
    await expect
      .poll(
        () => alice.getByRole('button', { name: 'Sync now', exact: true }).isEnabled(),
        { timeout: 10000 },
      )
      .toBe(true);
    const storage = await bob.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(storage).not.toContain('Bobby private planning');
    expect(storage).not.toContain('bob has a different password');
    await alice
      .getByRole('button', { name: 'Disconnect UltraSync on this device', exact: true })
      .click();
    await alice
      .getByRole('button', { name: 'Sign in and unlock', exact: true })
      .waitFor();
    expect(
      await alice.evaluate(() =>
        localStorage.getItem('ultra-native-account:' + location.origin),
      ),
    ).toBeNull();
    await aliceContext.close();
    await bobContext.close();
  }, 180000);
  it('withholds native background content keys until the personal dataset is explicitly linked', async () => {
    await h.register('native-keys@example.test', 'nativekeys');
    const source = await browser.newContext();
    try {
      await login(await pageFor(source), 'nativekeys', password);
    } finally {
      await source.close();
    }
    const context = await browser.newContext();
    try {
      const page = await pageFor(context);
      // Attach after app startup: exercise the real platform RPC and account
      // flow without pretending Chromium supplies the other Android APIs.
      await page.evaluate(() => {
        const host = window as unknown as {
          nativeScopeHandoffs: number[];
          SUPAndroid: {
            nativeAccountCall(id: string, method: string, payload: string): void;
          };
        };
        host.nativeScopeHandoffs = [];
        let tokens: unknown;
        host.SUPAndroid = {
          nativeAccountCall(requestId, method, payload) {
            const input = JSON.parse(payload);
            if (Array.isArray(input.scopes))
              host.nativeScopeHandoffs.push(input.scopes.length);
            if (method === 'configure') tokens = input.tokens;
            const data =
              method === 'current' || method === 'detach'
                ? tokens
                : method === 'reminder-barrier'
                  ? { version: 0 }
                  : {};
            window.dispatchEvent(
              new CustomEvent('ultra-native-account', {
                detail: { requestId, ok: true, data },
              }),
            );
          },
        };
      });
      await selectAppAccountServer(page, origin);
      await page.getByLabel('Email or username').fill('nativekeys');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in and unlock' }).click();
      await page.getByText('Connect personal data', { exact: true }).waitFor();
      const handoffs = () =>
        page.evaluate(
          () =>
            (window as unknown as { nativeScopeHandoffs: number[] }).nativeScopeHandoffs,
        );
      expect((await handoffs()).length).toBeGreaterThan(0);
      expect((await handoffs()).every((count) => count === 0)).toBe(true);
      await page.getByRole('button', { name: 'Use the account’s existing data' }).click();
      await page.getByRole('heading', { name: 'Shared projects' }).waitFor();
      await expect
        .poll(async () => (await handoffs()).some((count) => count > 0))
        .toBe(true);
    } finally {
      await context.close();
    }
  }, 60000);
  it('syncs an ordinary task through the personal bridge into a fresh second app device', async () => {
    await h.register('personal@example.test', 'personaltest');
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const first = await pageFor(firstContext);
    const second = await pageFor(secondContext);
    await login(first, 'personaltest', password);
    await first.goto(origin + '/#/tag/TODAY/tasks');
    await first.locator('task-list').first().waitFor();
    await first.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await first.keyboard.press('Shift+A');
    await first
      .locator('add-task-bar.global .main-input')
      .fill('Personal v2 task survives the bridge');
    await first.locator('.e2e-add-task-submit').click();
    await first.keyboard.press('Escape');
    await first
      .locator('task')
      .filter({ hasText: 'Personal v2 task survives the bridge' })
      .waitFor();
    await first.goto(origin + '/#/native-sync');
    await first.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect
      .poll(
        () => first.getByRole('button', { name: 'Sync now', exact: true }).isEnabled(),
        { timeout: 30000 },
      )
      .toBe(true);
    await login(second, 'personaltest', password, false);
    await second.goto(origin + '/#/tag/TODAY/tasks');
    await second
      .locator('task')
      .filter({ hasText: 'Personal v2 task survives the bridge' })
      .waitFor({ timeout: 30000 });
    expect(
      await second
        .locator('task')
        .filter({ hasText: 'Personal v2 task survives the bridge' })
        .count(),
    ).toBe(1);
    await firstContext.close();
    await secondContext.close();
  }, 120000);
});
