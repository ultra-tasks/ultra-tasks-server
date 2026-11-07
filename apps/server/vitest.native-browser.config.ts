import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/ultra-sync.browser.spec.ts'],
    testTimeout: 180000,
    hookTimeout: 60000,
  },
});
