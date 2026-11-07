import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/portal.ts'],
  format: ['iife'],
  platform: 'browser',
  noExternal: [
    '@ultra-tasks/account-crypto',
    '@serenity-kit/opaque',
    '@hpke/core',
    '@hpke/common',
    'hash-wasm',
  ],
  outDir: 'dist',
  clean: true,
  minify: true,
});
