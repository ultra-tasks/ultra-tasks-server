import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { createHarness, password } from './ultra-account.helper';

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
  const login = async (page: Page, importLocal: boolean): Promise<void> => {
    await page.getByLabel('Ultra Tasks server URL').fill(origin);
    await page.getByLabel('Email or username').fill('alice');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in and unlock' }).click();
    await page
      .getByText('Connect personal data', { exact: true })
      .waitFor({ timeout: 30000 });
    await page.getByLabel('I have backed up my data').check();
    await page
      .getByRole('button', {
        name: importLocal
          ? 'Import this device’s data'
          : 'Use the account’s existing data',
      })
      .click();
    await expect
      .poll(
        async () => ({
          connect: await page.getByText('Connect personal data', { exact: true }).count(),
          error: await page.locator('native-sync [role=alert]').allTextContents(),
        }),
        { timeout: 30000 },
      )
      .toEqual({ connect: 0, error: [] });
    await expect(page.getByRole('heading', { name: 'Shared projects' })).toHaveCount(0);
  };
  it('connects private accounts and propagates ordinary offline/concurrent edits without manual sync or sharing endpoints', async () => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      const first = await pageFor(firstContext);
      const second = await pageFor(secondContext);
      await login(first, true);
      await login(second, false);
      const add = async (page: Page, title: string): Promise<void> => {
        await page.goto(origin + '/#/tag/TODAY/tasks');
        await page.locator('task-list').first().waitFor();
        await page.locator('.tour-addBtn').click();
        await page.locator('add-task-bar.global .main-input').fill(title);
        await page.locator('.e2e-add-task-submit').click();
        await page.keyboard.press('Escape');
      };
      await add(first, 'Private first-device task');
      await second.goto(origin + '/#/tag/TODAY/tasks');
      await expect(
        second.locator('task').filter({ hasText: 'Private first-device task' }),
      ).toHaveCount(1, { timeout: 15000 });
      await secondContext.setOffline(true);
      await add(second, 'Private offline second-device task');
      await add(first, 'Private concurrent first-device task');
      await secondContext.setOffline(false);
      await expect(
        first.locator('task').filter({ hasText: 'Private offline second-device task' }),
      ).toHaveCount(1, { timeout: 20000 });
      await expect(
        second
          .locator('task')
          .filter({ hasText: 'Private concurrent first-device task' }),
      ).toHaveCount(1, { timeout: 20000 });
      await second.reload();
      await second.goto(origin + '/#/native-sync');
      await login(second, false);
      await second.goto(origin + '/#/tag/TODAY/tasks');
      for (const title of [
        'Private first-device task',
        'Private offline second-device task',
        'Private concurrent first-device task',
      ])
        await expect(second.locator('task').filter({ hasText: title })).toHaveCount(1, {
          timeout: 15000,
        });
    } finally {
      await firstContext.close();
      await secondContext.close();
    }
  }, 180000);
});
