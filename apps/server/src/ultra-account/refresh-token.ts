import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UltraConfig } from './security';

/**
 * Self-identifying refresh tokens (version 2).
 *
 *   token = base64url( sid16 | generation4 | mac16 )          36 bytes, 48 characters
 *   sid16        the 16 bytes of the session UUID
 *   generation4  uint32, big endian: how many times the session has rotated
 *   mac16        first 16 bytes of HMAC-SHA-256(refreshKey, "refresh-v2" | sid16 | generation4)
 *   refreshKey   HMAC-SHA-256(ULTRA_AUTH_SECRET, "ultra-refresh-token-v2")
 *
 * The session row stores only its current generation. A token for the current generation
 * rotates; a token for an older generation is a replay and revokes the session; a token from the
 * future is refused. Replay detection therefore needs no per-token row at all, covers every
 * rotation ever made (not only the latest few) and stores a constant amount per session. The MAC
 * is checked before the database is touched, so a forged or garbled token is an ordinary 401
 * that can never revoke anybody's session.
 */
export const REFRESH_V2_LENGTH = 48;
export const REFRESH_LEGACY_LENGTH = 43;
/** The largest generation a session can hold (a signed 32-bit database integer). */
export const MAX_REFRESH_GENERATION = 2147483647;
const REFRESH_TOKEN_PATTERN = /^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{48})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Accepts a legacy (43 characters) or a version 2 (48 characters) refresh token. */
export const isRefreshTokenShape = (value: string): boolean =>
  REFRESH_TOKEN_PATTERN.test(value);
export const isGenerationToken = (value: string): boolean =>
  value.length === REFRESH_V2_LENGTH;

const refreshKey = (config: UltraConfig): Buffer =>
  createHmac('sha256', config.authSecret).update('ultra-refresh-token-v2').digest();
const mac = (config: UltraConfig, session: Buffer, generation: Buffer): Buffer =>
  createHmac('sha256', refreshKey(config))
    .update(Buffer.concat([Buffer.from('refresh-v2'), session, generation]))
    .digest()
    .subarray(0, 16);
const uuidBytes = (id: string): Buffer | undefined =>
  UUID_PATTERN.test(id) ? Buffer.from(id.replace(/-/g, ''), 'hex') : undefined;
const uuidText = (bytes: Buffer): string => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const encodeRefresh = (
  config: UltraConfig,
  sessionId: string,
  generation: number,
): string => {
  const session = uuidBytes(sessionId);
  if (
    !session ||
    !Number.isInteger(generation) ||
    generation < 0 ||
    generation > 0xffffffff
  )
    throw new Error('Invalid refresh token parameters');
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(generation);
  return Buffer.concat([session, counter, mac(config, session, counter)]).toString(
    'base64url',
  );
};

/**
 * Splits a version 2 token into its session and generation after the MAC matched (constant
 * time). Returns undefined for anything else: wrong shape, wrong length, wrong MAC. Touches no
 * database and reveals nothing about why.
 */
export const parseRefresh = (
  config: UltraConfig,
  value: string,
): { sessionId: string; generation: number } | undefined => {
  if (value.length !== REFRESH_V2_LENGTH || !REFRESH_TOKEN_PATTERN.test(value)) return;
  const raw = Buffer.from(value, 'base64url');
  if (raw.length !== 36) return;
  const session = raw.subarray(0, 16);
  const counter = raw.subarray(16, 20);
  if (!timingSafeEqual(raw.subarray(20), mac(config, session, counter))) return;
  return { sessionId: uuidText(session), generation: counter.readUInt32BE(0) };
};
