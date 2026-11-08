import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadUltraConfig } from '../src/ultra-account';

describe('deployed account authentication configuration', () => {
  afterEach(() => vi.unstubAllEnvs());
  const enable = (): void => {
    vi.stubEnv('ULTRA_ACCOUNTS_ENABLED', 'true');
    vi.stubEnv('ULTRA_SERVER_ID', '3e2edea8-ff50-4f20-87f6-a8f0465f9945');
    vi.stubEnv('ULTRA_OPAQUE_SETUP', 'opaque-configuration-fixture');
    vi.stubEnv(
      'ULTRA_AUTH_SECRET',
      'configuration-fixture-secret-at-least-32-characters',
    );
    vi.stubEnv('ULTRA_AUTH_ENGINE', undefined);
  };
  it('defaults new deployments to Better Auth while preserving their installation identity', () => {
    enable();
    const config = loadUltraConfig('https://app.example.test');
    expect(config?.authEngine).toBe('better-auth');
    expect(config?.serverId).toBe('3e2edea8-ff50-4f20-87f6-a8f0465f9945');
    expect(config?.rpId).toBe('app.example.test');
  });
  it('honors an explicitly configured native engine for existing installations', () => {
    enable();
    vi.stubEnv('ULTRA_AUTH_ENGINE', 'native');
    expect(loadUltraConfig('https://app.example.test')?.authEngine).toBe('native');
  });
  it('refuses an unknown authentication engine', () => {
    enable();
    vi.stubEnv('ULTRA_AUTH_ENGINE', 'unknown');
    expect(() => loadUltraConfig('https://app.example.test')).toThrow(
      'ULTRA_AUTH_ENGINE',
    );
  });
});
