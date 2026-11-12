import type { Page } from '@playwright/test';

/** Explicitly select self-hosting when testing a build with an official origin. */
export const selectAppAccountServer = async (
  page: Page,
  origin: string,
): Promise<void> => {
  const input = page.getByLabel('Ultra Tasks server URL');
  await input.waitFor();
  const custom = page.getByRole('radio', { name: 'Custom server', exact: true });
  if (await custom.isVisible()) await custom.check();
  await input.fill(origin);
};
