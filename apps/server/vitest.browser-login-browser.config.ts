import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/browser-login.browser.spec.ts'],
    testTimeout: 120000,
    hookTimeout: 60000,
    maxWorkers: 1,
  },
});
