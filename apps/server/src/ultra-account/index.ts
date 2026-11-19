import { SESSION_IDLE_DAYS, SESSION_MAX_DAYS, UltraConfig } from './security';

export { ultraAccountRoutes } from './routes';

/** A whole number of days, or the default when the variable is unset or empty. */
const wholeDays = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max))
    throw new Error(`${name} must be a whole number of days from ${min} to ${max}`);
  return value;
};
/**
 * `ULTRA_DEVICE_EMAIL_VERIFICATION`: on unless the operator sets `false` (the kill switch). The
 * wiring also needs mail to be configured. Any other value fails at startup instead of silently
 * choosing a side for a security control.
 */
export const loadDeviceEmailSetting = (): boolean => {
  const raw = process.env.ULTRA_DEVICE_EMAIL_VERIFICATION?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('ULTRA_DEVICE_EMAIL_VERIFICATION must be true or false');
};
export const loadUltraConfig = (publicUrl: string): UltraConfig | undefined => {
  if (process.env.ULTRA_ACCOUNTS_ENABLED !== 'true') return;
  const serverId = process.env.ULTRA_SERVER_ID ?? '';
  const opaqueSetup = process.env.ULTRA_OPAQUE_SETUP ?? '';
  const authSecret = process.env.ULTRA_AUTH_SECRET ?? '';
  const authEngine = process.env.ULTRA_AUTH_ENGINE ?? 'better-auth';
  if (authEngine !== 'native' && authEngine !== 'better-auth')
    throw new Error('ULTRA_AUTH_ENGINE must be native or better-auth');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      serverId,
    ) ||
    !opaqueSetup ||
    authSecret.length < 32
  )
    throw new Error(
      'Ultra accounts require a stable ULTRA_SERVER_ID, ULTRA_OPAQUE_SETUP, and ULTRA_AUTH_SECRET (32+ characters)',
    );
  const sessionIdleDays = wholeDays(
    'ULTRA_SESSION_IDLE_DAYS',
    SESSION_IDLE_DAYS,
    1,
    3650,
  );
  // 0 removes the absolute cap, so a trusted device is only ever signed out by inactivity.
  const sessionMaxDays = wholeDays('ULTRA_SESSION_MAX_DAYS', SESSION_MAX_DAYS, 0, 36500);
  // An absolute cap shorter than the idle window would silently shorten every sliding session.
  if (sessionMaxDays !== 0 && sessionMaxDays < sessionIdleDays)
    throw new Error(
      `ULTRA_SESSION_MAX_DAYS (${sessionMaxDays}) must be 0 (no cap) or at least ULTRA_SESSION_IDLE_DAYS (${sessionIdleDays})`,
    );
  return {
    serverId,
    opaqueSetup,
    authSecret,
    authEngine,
    publicUrl: new URL(publicUrl).origin,
    rpId: new URL(publicUrl).hostname,
    sessionIdleDays,
    sessionMaxDays,
  };
};
