import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { createHarness, password } from './ultra-account.helper';
import { selectAppAccountServer } from './app-account-ui.helper';

describe('Public calendar through the real Angular app and account server', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    vi.stubEnv('ULTRA_CALENDAR_FEEDS_ENABLED', 'true');
    if (!process.env.ULTRA_CLIENT_DIST) throw new Error('ULTRA_CLIENT_DIST required');
    h = await createHarness({ privateOnly: true });
    await h.app.register(fastifyStatic, { root: resolve(process.env.ULTRA_CLIENT_DIST) });
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    origin = `http://localhost:${address.port}`;
    h.config.publicUrl = origin;
    await h.register();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await h?.close();
    vi.unstubAllEnvs();
  });
  it('publishes selected busy times, updates, rotates and stops; notes never leave the app', async () => {
    const context = await browser.newContext({ userAgent: 'PLAYWRIGHT' });
    try {
      await context.addInitScript(() => {
        for (const key of [
          'SUP_ONBOARDING_PRESET_DONE',
          'SUP_ONBOARDING_HINTS_DONE',
          'SUP_IS_SHOW_TOUR',
          'SUP_EXAMPLE_TASKS_CREATED',
        ])
          localStorage.setItem(key, 'true');
      });
      const page = await context.newPage();
      await page.goto(origin + '/#/native-sync');
      await selectAppAccountServer(page, origin);
      await page.getByLabel('Email or username').fill('alice');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in and unlock' }).click();
      await ui(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled({
        timeout: 30000,
      });
      await page.goto(origin + '/#/tag/TODAY/tasks');
      await page.locator('task-list').first().waitFor();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Shift+A');
      await page.locator('add-task-bar.global .main-input').fill('Confidential meeting');
      await page.locator('.e2e-add-task-submit').click();
      await page.keyboard.press('Escape');
      await ui(
        page.locator('task').filter({ hasText: 'Confidential meeting' }),
      ).toBeVisible();
      await page.goto(origin + '/#/native-sync');
      const form = page.locator('calendar-publications');
      await form.getByLabel('Calendar label', { exact: true }).fill('Availability');
      await ui(form.getByLabel('What to show')).toHaveValue('busy');
      await ui(
        form.getByRole('button', { name: 'Publish calendar', exact: true }),
      ).toBeDisabled();
      await form.getByRole('checkbox').check();
      await form.getByRole('button', { name: 'Publish calendar', exact: true }).click();
      const urlInput = form.getByLabel('Subscription URL', { exact: true });
      await ui(urlInput).toHaveValue(/\/cal\/[^/]+\.ics$/);
      const url = await urlInput.inputValue();
      expect(
        (
          await h.database.query<{ total: number }>(
            'SELECT count(*)::int AS total FROM ultra_calendar_feeds',
          )
        ).rows[0].total,
      ).toBe(1);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const initial = await response.text();
      expect(initial).toContain('SUMMARY:Busy');
      expect(initial).not.toContain('Confidential');
      expect(initial).toContain('VALUE=DATE');
      await page.goto(origin + '/#/tag/TODAY/tasks');
      const task = page.locator('task').filter({ hasText: 'Confidential meeting' });
      await task.locator('done-toggle').click();
      await expect
        .poll(async () => (await (await fetch(url)).text()).includes('BEGIN:VEVENT'), {
          timeout: 15000,
          interval: 1000,
        })
        .toBe(false);
      await task.locator('done-toggle').click();
      const uid = initial.split('\r\n').find((line) => line.startsWith('UID:'))!;
      await expect
        .poll(async () => await (await fetch(url)).text(), {
          timeout: 15000,
          interval: 1000,
        })
        .toContain(uid);
      expect(await (await fetch(url)).text()).not.toContain('Confidential');
      await page.goto(origin + '/#/native-sync');
      await ui(page.locator('calendar-publications')).toHaveCount(1);
      await form.getByRole('button', { name: 'Rotate URL' }).click();
      await ui(urlInput).toHaveValue(/\/cal\//);
      const rotated = await urlInput.inputValue();
      expect(rotated).not.toBe(url);
      expect((await fetch(url)).status).toBe(404);
      expect((await fetch(rotated)).status).toBe(200);
      await form.getByRole('button', { name: 'Stop publishing' }).click();
      await ui(
        form.getByRole('heading', { name: 'Availability', exact: true }),
      ).toHaveCount(0);
      expect((await fetch(rotated)).status).toBe(404);
    } finally {
      await context.close();
    }
  }, 120000);
});
