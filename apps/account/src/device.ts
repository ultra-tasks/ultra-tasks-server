import { encode, utf8 } from '@ultra-tasks/account-crypto';

/**
 * A label for this browser such as "Firefox on Windows". It is only text for the
 * device list and is never evidence of identity: the server trusts a device because of
 * a random token it issued, not because of this name.
 */
export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
}
const browserName = (ua: string): string | undefined => {
  if (/\b(?:Edg|EdgA|EdgiOS)\//.test(ua)) return 'Edge';
  if (/\b(?:OPR|OPT)\/|\bOpera\b/.test(ua)) return 'Opera';
  if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/\bVivaldi\//.test(ua)) return 'Vivaldi';
  if (/\bFxiOS\/|\bFirefox\//.test(ua)) return 'Firefox';
  if (/CriOS\/|Chrome\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'Safari';
  return undefined;
};
const systemName = (nav: NavigatorLike): string | undefined => {
  const ua = nav.userAgent;
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\biPhone\b/.test(ua)) return 'iPhone';
  if (/\biPad\b/.test(ua)) return 'iPad';
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bWindows\b/.test(ua)) return 'Windows';
  // iPadOS asks for the desktop site by default and then reports itself as a Mac.
  if (/\bMacintosh\b|\bMac OS X\b/.test(ua))
    return (nav.maxTouchPoints ?? 0) > 1 ? 'iPad' : 'macOS';
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux';
  return undefined;
};
export const deviceLabel = (nav: NavigatorLike = navigator): string => {
  const browser = browserName(nav.userAgent);
  const system = systemName(nav);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? (system ? `Browser on ${system}` : 'This browser');
};

/**
 * The opaque device token the server issues after an email check, remembered in this
 * browser so later sign-ins do not ask again. It is a convenience for this viewer only:
 * it never authenticates by itself and it is useless without the password. Storage can
 * be unavailable (private windows, blocked site data), so every access is guarded.
 */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const keyFor = async (origin: string, identifier: string): Promise<string> =>
  `ultra-device-token-v1:${origin}:${encode(
    await crypto.subtle.digest('SHA-256', utf8(identifier.trim().toLowerCase())),
  )}`;
export const loadDeviceToken = async (
  origin: string,
  identifier: string,
): Promise<string | undefined> => {
  try {
    const stored = localStorage.getItem(await keyFor(origin, identifier));
    return stored && TOKEN.test(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
};
export const saveDeviceToken = async (
  origin: string,
  identifiers: string[],
  token: string | undefined,
): Promise<void> => {
  if (!token || !TOKEN.test(token)) return;
  for (const identifier of new Set(identifiers.filter(Boolean)))
    try {
      localStorage.setItem(await keyFor(origin, identifier), token);
    } catch {
      /* Not remembered: the next sign-in on this browser asks for a code again. */
    }
};
export const clearDeviceToken = async (
  origin: string,
  identifiers: string[],
): Promise<void> => {
  for (const identifier of new Set(identifiers.filter(Boolean)))
    try {
      localStorage.removeItem(await keyFor(origin, identifier));
    } catch {
      /* Nothing to clear. */
    }
};
