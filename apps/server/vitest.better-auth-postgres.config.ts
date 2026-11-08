import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/better-auth-refresh.integration.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 1,
    sequence: { concurrent: false },
  },
});
