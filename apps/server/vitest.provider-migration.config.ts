import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/provider-migration.harness.ts'],
    testTimeout: 3600000,
    hookTimeout: 60000,
  },
});
