import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDeviceEmailSetting, loadUltraConfig } from '../src/ultra-account';

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

  describe('session lifetime', () => {
    it('defaults to a 180 day sliding window and a 1095 day absolute cap', () => {
      enable();
      vi.stubEnv('ULTRA_SESSION_IDLE_DAYS', undefined);
      vi.stubEnv('ULTRA_SESSION_MAX_DAYS', undefined);
      const config = loadUltraConfig('https://app.example.test');
      expect(config?.sessionIdleDays).toBe(180);
      expect(config?.sessionMaxDays).toBe(1095);
      vi.stubEnv('ULTRA_SESSION_IDLE_DAYS', '');
      vi.stubEnv('ULTRA_SESSION_MAX_DAYS', ' ');
      expect(loadUltraConfig('https://app.example.test')).toMatchObject({
        sessionIdleDays: 180,
        sessionMaxDays: 1095,
      });
    });
    it('accepts operator values, where zero removes the absolute cap', () => {
      enable();
      vi.stubEnv('ULTRA_SESSION_IDLE_DAYS', '30');
      vi.stubEnv('ULTRA_SESSION_MAX_DAYS', '0');
      expect(loadUltraConfig('https://app.example.test')).toMatchObject({
        sessionIdleDays: 30,
        sessionMaxDays: 0,
      });
      vi.stubEnv('ULTRA_SESSION_IDLE_DAYS', '3650');
      vi.stubEnv('ULTRA_SESSION_MAX_DAYS', '36500');
      expect(loadUltraConfig('https://app.example.test')).toMatchObject({
        sessionIdleDays: 3650,
        sessionMaxDays: 36500,
      });
    });
    it('refuses an absolute cap that is shorter than the idle window', () => {
      enable();
      vi.stubEnv('ULTRA_SESSION_IDLE_DAYS', '400');
      vi.stubEnv('ULTRA_SESSION_MAX_DAYS', '399');
      expect(() => loadUltraConfig('https://app.example.test')).toThrow(
        'ULTRA_SESSION_MAX_DAYS (399) must be 0 (no cap) or at least ULTRA_SESSION_IDLE_DAYS (400)',
      );
      // Equal is allowed, and zero removes the cap whatever the idle window.
      vi.stubEnv('ULTRA_SESSION_MAX_DAYS', '400');
      expect(loadUltraConfig('https://app.example.test')).toMatchObject({
        sessionIdleDays: 400,
        sessionMaxDays: 400,
      });
      vi.stubEnv('ULTRA_SESSION_IDLE_DAYS', '3650');
      vi.stubEnv('ULTRA_SESSION_MAX_DAYS', '0');
      expect(loadUltraConfig('https://app.example.test')?.sessionMaxDays).toBe(0);
      // The defaults (180 idle, 1095 cap) are consistent; a long idle window alone is not.
      vi.stubEnv('ULTRA_SESSION_IDLE_DAYS', '2000');
      vi.stubEnv('ULTRA_SESSION_MAX_DAYS', undefined);
      expect(() => loadUltraConfig('https://app.example.test')).toThrow(
        'ULTRA_SESSION_MAX_DAYS (1095)',
      );
    });
    it.each([
      ['ULTRA_SESSION_IDLE_DAYS', '0'],
      ['ULTRA_SESSION_IDLE_DAYS', '3651'],
      ['ULTRA_SESSION_IDLE_DAYS', '-5'],
      ['ULTRA_SESSION_IDLE_DAYS', '1.5'],
      ['ULTRA_SESSION_IDLE_DAYS', 'forever'],
      ['ULTRA_SESSION_MAX_DAYS', '-1'],
      ['ULTRA_SESSION_MAX_DAYS', '36501'],
      ['ULTRA_SESSION_MAX_DAYS', '2e3'],
      ['ULTRA_SESSION_MAX_DAYS', 'none'],
    ])('refuses %s=%s instead of guessing a lifetime', (name, value) => {
      enable();
      vi.stubEnv(name, value);
      expect(() => loadUltraConfig('https://app.example.test')).toThrow(name);
    });
  });

  describe('new-device email verification switch', () => {
    it('is on unless the operator sets false, and any other value stops startup', () => {
      vi.stubEnv('ULTRA_DEVICE_EMAIL_VERIFICATION', undefined);
      expect(loadDeviceEmailSetting()).toBe(true);
      vi.stubEnv('ULTRA_DEVICE_EMAIL_VERIFICATION', '');
      expect(loadDeviceEmailSetting()).toBe(true);
      vi.stubEnv('ULTRA_DEVICE_EMAIL_VERIFICATION', 'true');
      expect(loadDeviceEmailSetting()).toBe(true);
      vi.stubEnv('ULTRA_DEVICE_EMAIL_VERIFICATION', ' FALSE ');
      expect(loadDeviceEmailSetting()).toBe(false);
      for (const value of ['0', 'off', 'no', 'disabled']) {
        vi.stubEnv('ULTRA_DEVICE_EMAIL_VERIFICATION', value);
        expect(() => loadDeviceEmailSetting()).toThrow('ULTRA_DEVICE_EMAIL_VERIFICATION');
      }
    });
  });
});
