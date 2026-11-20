import type { Page } from '@playwright/test';

export const appAccount = (page: Page) => page.locator('native-sync:visible');

export const appAccountIdentifier = (page: Page) =>
  appAccount(page).locator('input[name="identifier"]');

/** Explicitly select self-hosting when testing a build with an official origin. */
export const selectAppAccountServer = async (
  page: Page,
  origin: string,
): Promise<void> => {
  const account = appAccount(page);
  await appAccountIdentifier(page).waitFor();
  const custom = account.getByRole('radio', { name: 'Custom server', exact: true });
  if (await custom.isVisible()) await custom.check();
  const input = account.locator('input[name="server"]');
  if (await input.isVisible()) await input.fill(origin);
};

export const submitAppAccountSignIn = async (
  page: Page,
  origin: string,
  identifier: string,
  password: string,
): Promise<void> => {
  await selectAppAccountServer(page, origin);
  await appAccountIdentifier(page).fill(identifier);
  const account = appAccount(page);
  await account.locator('input[name="password"]').fill(password);
  await account.locator('form:has(input[name="password"]) button[type="submit"]').click();
};

/** The development app exposes the same readiness used by its status controls. */
export const waitForAppAccountSync = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    () => {
      const app = (window as unknown as { __e2eNativeSync?: { linked(): boolean } })
        .__e2eNativeSync;
      return app?.linked() === true;
    },
    undefined,
    { timeout: 45_000 },
  );
};
