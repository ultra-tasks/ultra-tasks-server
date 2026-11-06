import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/ultra-realtime.load.ts'],
    testTimeout: 240000,
    hookTimeout: 30000,
  },
});
