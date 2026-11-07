import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

if (!process.env.ULTRA_CLIENT_SOURCE)
  throw new Error('ULTRA_CLIENT_SOURCE is required for cross-repository parity');

export default defineConfig({
  resolve: {
    alias: {
      '@ultra-tasks/client-test-port': resolve(
        process.env.ULTRA_CLIENT_SOURCE,
        'src/app/op-log/testing/integration/sync-fuzz/fake-super-sync-server.ts',
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/sync-fuzz-server*.pglite.spec.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
