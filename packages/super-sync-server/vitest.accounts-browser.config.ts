import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/ultra-accounts.browser.spec.ts'],
    testTimeout: 90000,
    hookTimeout: 30000,
  },
});
