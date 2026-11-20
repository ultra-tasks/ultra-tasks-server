import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { createHarness, password } from './ultra-account.helper';
import {
  appAccount,
  submitAppAccountSignIn,
  waitForAppAccountSync,
} from './app-account-ui.helper';

describe('private v1 sync through two real Angular clients', () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    if (!process.env.ULTRA_CLIENT_DIST) throw new Error('ULTRA_CLIENT_DIST is required');
    harness = await createHarness({ privateOnly: true });
    await harness.app.register(fastifyStatic, {
      root: resolve(process.env.ULTRA_CLIENT_DIST),
    });
    harness.app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html'),
    );
    await harness.app.listen({ host: '127.0.0.1', port: 0 });
    const address = harness.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No browser address');
    origin = 'http://localhost:' + address.port;
    harness.config.publicUrl = origin;
    await harness.register();
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN,
      headless: true,
      args: ['--no-sandbox'],
    });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await harness?.close();
  });
  const pageFor = async (context: BrowserContext): Promise<Page> => {
    const page = await context.newPage();
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
    return page;
  };
  const unlock = (page: Page): Promise<void> =>
    submitAppAccountSignIn(page, origin, 'alice', password);
  const dataPending = (page: Page) =>
    page
      .locator('native-sync .data-card:visible, dialog-account-data-choice:visible')
      .first();
  const login = async (page: Page): Promise<void> => {
    await unlock(page);
    await waitForAppAccountSync(page);
    await browserExpect(dataPending(page)).toHaveCount(0);
    await browserExpect(appAccount(page).getByRole('alert')).toHaveCount(0);
    await browserExpect(
      page.getByRole('heading', { name: 'Shared projects' }),
    ).toHaveCount(0);
  };
  it('connects private accounts and propagates ordinary offline/concurrent edits without manual sync or sharing endpoints', async () => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      const first = await pageFor(firstContext);
      const second = await pageFor(secondContext);
      await login(first);
      await login(second);
      const add = async (page: Page, title: string): Promise<void> => {
        if (!page.url().endsWith('/#/tag/TODAY/tasks'))
          await page.goto(origin + '/#/tag/TODAY/tasks');
        await page.locator('task-list').first().waitFor();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('Shift+A');
        await page.locator('add-task-bar.global .main-input').fill(title);
        await page.locator('.e2e-add-task-submit').click();
        await page.keyboard.press('Escape');
      };
      await add(first, 'Private first-device task');
      await second.goto(origin + '/#/tag/TODAY/tasks');
      await browserExpect(
        second.locator('task').filter({ hasText: 'Private first-device task' }),
      ).toHaveCount(1, { timeout: 15000 });
      await secondContext.setOffline(true);
      await add(second, 'Private offline second-device task');
      await add(first, 'Private concurrent first-device task');
      await secondContext.setOffline(false);
      await browserExpect(
        first.locator('task').filter({ hasText: 'Private offline second-device task' }),
      ).toHaveCount(1, { timeout: 20000 });
      await browserExpect(
        second
          .locator('task')
          .filter({ hasText: 'Private concurrent first-device task' }),
      ).toHaveCount(1, { timeout: 20000 });
      await second.reload();
      await second.goto(origin + '/#/native-sync');
      await login(second);
      await second.goto(origin + '/#/tag/TODAY/tasks');
      for (const title of [
        'Private first-device task',
        'Private offline second-device task',
        'Private concurrent first-device task',
      ])
        await browserExpect(
          second.locator('task').filter({ hasText: title }),
        ).toHaveCount(1, {
          timeout: 15000,
        });
      // Locking and a full restart still reserve the saved UltraTasks account connection.
      await second.goto(origin + '/#/native-sync');
      const nativePage = appAccount(second);
      await browserExpect(nativePage).toHaveCount(1);
      await nativePage.locator('.account-options > summary').click();
      await nativePage.getByRole('button', { name: /^Lock(?: account)?$/ }).click();
      await second.reload();
      await second.goto(origin + '/#/native-sync');
      const signOut = nativePage.getByRole('button', {
        name: /^Sign out of this device$/,
      });
      await browserExpect(signOut).toBeVisible();
      await signOut.click();
      await browserExpect(signOut).toHaveCount(0);
      await second.goto(origin + '/#/tag/TODAY/tasks');
      for (const title of [
        'Private first-device task',
        'Private offline second-device task',
        'Private concurrent first-device task',
      ])
        await browserExpect(
          second.locator('task').filter({ hasText: title }),
        ).toHaveCount(1);

      // A disconnected device may have used another provider. Signing back in
      // must leave its local data untouched until the user explicitly connects.
      const disconnectedTask = 'Private disconnected second-device task';
      await secondContext.setOffline(true);
      await add(second, disconnectedTask);
      await secondContext.setOffline(false);
      await second.goto(origin + '/#/native-sync');
      await unlock(second);
      await browserExpect(dataPending(second)).toBeVisible({ timeout: 30000 });
      await second.reload();
      await unlock(second);
      await browserExpect(dataPending(second)).toBeVisible({ timeout: 30000 });
      await second.goto(origin + '/#/tag/TODAY/tasks');
      await browserExpect(
        second.locator('task').filter({ hasText: disconnectedTask }),
      ).toHaveCount(1);
      await browserExpect(
        first.locator('task').filter({ hasText: disconnectedTask }),
      ).toHaveCount(0);
      for (const title of [
        'Private first-device task',
        'Private offline second-device task',
        'Private concurrent first-device task',
      ])
        await browserExpect(first.locator('task').filter({ hasText: title })).toHaveCount(
          1,
        );
    } finally {
      await firstContext.close();
      await secondContext.close();
    }
  }, 180000);
});
