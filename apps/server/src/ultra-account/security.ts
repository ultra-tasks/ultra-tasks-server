import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { canonical, open, seal } from '@ultra-tasks/account-crypto';
import { AccountRow, SessionRow, UltraDb, one } from './store';
import {
  authenticateBetterAuth,
  BETTER_AUTH_TOKEN_PREFIX,
  issueBetterAuthAccess,
} from './better-auth';
import {
  encodeRefresh,
  isGenerationToken,
  MAX_REFRESH_GENERATION,
  parseRefresh,
} from './refresh-token';

export interface UltraConfig {
  serverId: string;
  opaqueSetup: string;
  authSecret: string;
  publicUrl: string;
  rpId: string;
  /** V1 production exposes personal scopes only; full mode is retained for compatibility tests. */
  privateOnly?: boolean;
  /** Better Auth is the deployment default; native is retained for existing installations. */
  authEngine?: 'native' | 'better-auth';
  /** Sliding session lifetime in days (default 180); renewed on every refresh. */
  sessionIdleDays?: number;
  /** Absolute session lifetime in days (default 1095); 0 removes the cap. */
  sessionMaxDays?: number;
}
export const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const token = (): string => randomBytes(32).toString('base64url');
export class AccountError extends Error {
  constructor(
    public statusCode: number,
    message = 'Invalid or expired credentials',
    /** Stable machine-readable reason sent next to the message; clients must not parse text. */
    public code?: string,
    public readonly writeIndices?: readonly number[],
  ) {
    super(message);
  }
}
/** The JSON body for a refused request: `{ error }`, plus `code` when the failure has one. */
export const accountErrorBody = (
  error: AccountError,
): { error: string; code?: string; writeIndices?: readonly number[] } => ({
  error: error.message,
  ...(error.code ? { code: error.code } : {}),
  ...(error.writeIndices ? { writeIndices: error.writeIndices } : {}),
});

const DB_TEMPORARY_ERRORS: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  '53300',
  '57P01',
  '57P02',
  '57P03',
]);

const storeErrorCode = (error: unknown): unknown => {
  if (error instanceof Prisma.PrismaClientInitializationError) return error.errorCode;
  if (error instanceof Prisma.PrismaClientKnownRequestError)
    return error.code === 'P2010' ? error.meta?.['code'] : error.code;
  return error instanceof Error && 'code' in error ? error.code : undefined;
};

/** Keep transient database failures separate from an authoritative session refusal. */
export const withAccountStore = async <T>(operation: Promise<T>): Promise<T> => {
  try {
    return await operation;
  } catch (error) {
    // Better Auth's session endpoint wraps a failed adapter lookup with Error.cause.
    const cause = error instanceof Error && 'cause' in error ? error.cause : undefined;
    if (
      [storeErrorCode(error), storeErrorCode(cause)].some(
        (code) =>
          typeof code === 'string' &&
          (DB_TEMPORARY_ERRORS.has(code) || /^08[A-Z0-9]{3}$/.test(code)),
      )
    )
      throw new AccountError(503, 'Account service temporarily unavailable');
    throw error;
  }
};
export const DAY = 86400000;

export const SESSION_IDLE_DAYS = 180;
export const SESSION_MAX_DAYS = 1095;
export const MAX_LIVE_SESSIONS = 30;
/** A revoked session is kept this long after its last activity (for the sessions list), then purged. */
export const REVOKED_SESSION_RETENTION = 30 * DAY;
/** Stored as `expires_at` when the operator removes the absolute cap (the largest JS date). */
export const NO_ABSOLUTE_EXPIRY = 8_640_000_000_000_000;
/** The sliding idle window in milliseconds; trusted devices follow the same window. */
export const sessionIdleMs = (config: UltraConfig): number =>
  (config.sessionIdleDays ?? SESSION_IDLE_DAYS) * DAY;
const idleWindow = sessionIdleMs;
/**
 * A live session with no sign-in or refresh for this long may be retired to make room for a new
 * one at the live-session cap. Sessions active within it are never retired.
 */
export const STALE_SESSION_AFTER = DAY;
/** Expiry values for a session issued at `now`: absolute cap set once, idle window slid. */
export const sessionLimits = (config: UltraConfig, now = Date.now()) => {
  const maxDays = config.sessionMaxDays ?? SESSION_MAX_DAYS;
  const expiresAt = maxDays === 0 ? NO_ABSOLUTE_EXPIRY : now + maxDays * DAY;
  return { expiresAt, idleExpiresAt: Math.min(expiresAt, now + idleWindow(config)) };
};
/** Refresh slides only the idle window; the absolute expiry never moves after issue. */
export const renewedIdleExpiry = (
  config: UltraConfig,
  session: Pick<SessionRow, 'expires_at'>,
  now = Date.now(),
): number => Math.min(Number(session.expires_at), now + idleWindow(config));
export const privateKey = (config: UltraConfig): string =>
  createHmac('sha256', config.authSecret)
    .update('ultra-account-storage-v1')
    .digest('base64url');
export const encodePrivate = async (
  config: UltraConfig,
  purpose: string,
  data: unknown,
): Promise<string> =>
  JSON.stringify(
    await seal(privateKey(config), canonical(data), config.serverId + ':' + purpose),
  );
export const decodePrivate = async <T>(
  config: UltraConfig,
  purpose: string,
  data: unknown,
): Promise<T> =>
  JSON.parse(
    await open(
      privateKey(config),
      JSON.parse(String(data)),
      config.serverId + ':' + purpose,
    ),
  ) as T;

export const challenge = async (
  db: UltraDb,
  config: UltraConfig,
  kind: string,
  accountId: string | null,
  data: unknown,
  ttl = 300000,
): Promise<string> => {
  const value = token();
  await db.$executeRaw(
    Prisma.sql`DELETE FROM ultra_challenges WHERE expires_at < ${BigInt(Date.now())}`,
  );
  const encrypted = await encodePrivate(config, digest(value), data);
  await db.$executeRaw(
    Prisma.sql`INSERT INTO ultra_challenges(digest,kind,account_id,expires_at,data) VALUES (${digest(value)},${kind},${accountId},${BigInt(Date.now() + ttl)},${JSON.stringify(encrypted)}::jsonb)`,
  );
  return value;
};
export const readChallenge = async <T>(
  db: UltraDb,
  config: UltraConfig,
  value: string,
  kind: string,
  consume = false,
): Promise<{ accountId: string | null; data: T }> => {
  const sql = consume
    ? Prisma.sql`DELETE FROM ultra_challenges WHERE digest=${digest(value)} AND kind=${kind} AND expires_at>${BigInt(Date.now())} AND attempts<=5 RETURNING account_id,data`
    : Prisma.sql`UPDATE ultra_challenges SET attempts=attempts+1 WHERE digest=${digest(value)} AND kind=${kind} AND expires_at>${BigInt(Date.now())} AND attempts<5 RETURNING account_id,data`;
  const row = await one<{ account_id: string | null; data: unknown }>(db, sql);
  if (!row) throw new AccountError(401);
  return {
    accountId: row.account_id,
    data: await decodePrivate<T>(config, digest(value), row.data),
  };
};
/** The caller holds the account lock; see the lock order: account, challenge, then session. */
export const lockAccount = async (tx: UltraDb, id: string): Promise<AccountRow> => {
  const account = await one<AccountRow>(
    tx,
    Prisma.sql`SELECT * FROM ultra_accounts WHERE id=${id} FOR UPDATE`,
  );
  if (!account) throw new AccountError(401);
  return account;
};
/** Locks and returns the caller's session as it is now (its device binding may have changed). */
export const requireLiveSession = async (
  tx: UltraDb,
  session: SessionRow,
): Promise<SessionRow> => {
  const now = BigInt(Date.now());
  const live = await one<SessionRow>(
    tx,
    Prisma.sql`SELECT * FROM ultra_sessions WHERE id=${session.id} AND account_id=${session.account_id} AND revoked=false AND expires_at>${now} AND idle_expires_at>${now} FOR UPDATE`,
  );
  if (!live) throw new AccountError(401);
  return live;
};

/* Live-session cap: 30 per account. At the cap a new sign-in retires the least recently active
   session, but only one with no sign-in or refresh for a day, so a session that is in use is never
   evicted and a flood of fresh sign-ins is still refused. The usual cause is orphans: a client
   that signs in again after a restart leaves its earlier session unused for the idle window. */
const sessionActivity = Prisma.raw('GREATEST(s.created_at, s.refreshed_at)');
const liveSessionCount = async (db: UltraDb, accountId: string, now: number) =>
  Number(
    (
      await one<{ count: bigint }>(
        db,
        Prisma.sql`SELECT count(*) AS count FROM ultra_sessions WHERE account_id=${accountId} AND revoked=false AND expires_at>${BigInt(now)} AND idle_expires_at>${BigInt(now)}`,
      )
    )?.count ?? 0,
  );
const staleSessions = (db: UltraDb, accountId: string, now: number, limit: number) =>
  db.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT s.id FROM ultra_sessions s WHERE s.account_id=${accountId} AND s.revoked=false AND s.expires_at>${BigInt(now)} AND s.idle_expires_at>${BigInt(now)} AND ${sessionActivity}<${BigInt(now - STALE_SESSION_AFTER)} ORDER BY ${sessionActivity} ASC, s.created_at ASC, s.id LIMIT ${Prisma.raw(String(Math.max(1, Math.trunc(limit))))}`,
  );
const sessionLimitReached = () =>
  new AccountError(
    409,
    'Revoke an old device session before signing in again',
    'session_limit',
  );
/**
 * Read-only: could one more session be issued, directly or by retiring a stale one? Used before an
 * email is sent. Nothing is retired here: a password alone must not be able to end sessions.
 */
export const assertSessionCapacity = async (
  db: UltraDb,
  accountId: string,
): Promise<void> => {
  const now = Date.now();
  if ((await liveSessionCount(db, accountId, now)) < MAX_LIVE_SESSIONS) return;
  if (!(await staleSessions(db, accountId, now, 1)).length) throw sessionLimitReached();
};
/** At issue time (policy already satisfied): retire stale sessions until there is room, or refuse. */
const makeSessionRoom = async (db: UltraDb, accountId: string, now: number) => {
  const needed = (await liveSessionCount(db, accountId, now)) - MAX_LIVE_SESSIONS + 1;
  if (needed < 1) return;
  const stale = await staleSessions(db, accountId, now, needed);
  if (stale.length < needed) throw sessionLimitReached();
  await db.$executeRaw(
    Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE account_id=${accountId} AND id IN (${Prisma.join(stale.map((row) => row.id))})`,
  );
};
export const issueSession = async (
  db: UltraDb,
  config: UltraConfig,
  accountId: string,
  deviceName: string,
  options: { deviceId?: string | null } = {},
) => {
  const id = crypto.randomUUID();
  const now = Date.now();
  // Expired sessions go, and so do revoked ones thirty days after their last activity: the list
  // keeps a recent record of what was ended, not a permanent one.
  await db.$executeRaw(
    Prisma.sql`DELETE FROM ultra_sessions s WHERE s.expires_at<${BigInt(now)} OR s.idle_expires_at<${BigInt(now)} OR (s.revoked=true AND ${sessionActivity}<${BigInt(now - REVOKED_SESSION_RETENTION)})`,
  );
  await makeSessionRoom(db, accountId, now);
  const { expiresAt, idleExpiresAt } = sessionLimits(config, now);
  await db.$executeRaw(
    Prisma.sql`INSERT INTO ultra_sessions(id,account_id,device_name,created_at,auth_at,expires_at,idle_expires_at,device_id,refresh_generation,refreshed_at) VALUES (${id},${accountId},${deviceName},${BigInt(now)},${BigInt(now)},${BigInt(expiresAt)},${BigInt(idleExpiresAt)},${options.deviceId ?? null},0,${BigInt(now)})`,
  );
  return issueTokens(db, config, { id, account_id: accountId }, 0);
};
/**
 * The access token and the refresh token for `generation`. Refresh tokens carry their own
 * generation and a MAC (see refresh-token.ts), so issuing one writes nothing.
 */
export const issueTokens = async (
  db: UltraDb,
  config: UltraConfig,
  session: Pick<SessionRow, 'id' | 'account_id'>,
  generation: number,
) => {
  const refreshToken = encodeRefresh(config, session.id, generation);
  const accessToken =
    config.authEngine === 'better-auth'
      ? await issueBetterAuthAccess(db, config, session)
      : jwt.sign({ sid: session.id }, config.authSecret, {
          subject: session.account_id,
          audience: 'ultra-account-v2',
          issuer: config.serverId,
          expiresIn: '10m',
          algorithm: 'HS256',
        });
  return { accessToken, refreshToken, expiresIn: 600 };
};

const lockSession = (tx: UltraDb, id: string) =>
  one<SessionRow>(tx, Prisma.sql`SELECT * FROM ultra_sessions WHERE id=${id} FOR UPDATE`);
const isLive = (session: SessionRow, now: number): boolean =>
  !session.revoked &&
  Number(session.expires_at) > now &&
  Number(session.idle_expires_at) > now;
/** Reuse: the whole session ends. The caller commits the revocation and answers a plain 401. */
const revokeForReuse = (tx: UltraDb, sessionId: string) =>
  tx.$executeRaw(
    Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE id=${sessionId}`,
  );
/** Moves the session to `generation`, slides its idle window and issues that generation's token. */
const advance = async (
  tx: UltraDb,
  config: UltraConfig,
  session: SessionRow,
  generation: number,
  now: number,
) => {
  await tx.$executeRaw(
    Prisma.sql`UPDATE ultra_sessions SET refresh_generation=${generation},refreshed_at=${BigInt(now)},idle_expires_at=${BigInt(renewedIdleExpiry(config, session, now))} WHERE id=${session.id}`,
  );
  return issueTokens(tx, config, session, generation);
};

/**
 * Single-use refresh rotation; returns null for every refusal so callers answer one generic 401.
 *
 * Presenting a token that was already used revokes its whole session, with no leeway window and
 * no matter how many rotations have happened since: if a rotation response is lost, the retry
 * ends the session and the client must sign in again (docs/account-devices-and-sessions.md,
 * "lost-response case"). The caller must run this inside a transaction and commit the null that
 * follows a revocation.
 */
export const rotateRefresh = (tx: UltraDb, config: UltraConfig, refreshToken: string) =>
  isGenerationToken(refreshToken)
    ? rotateGeneration(tx, config, refreshToken)
    : rotateLegacy(tx, config, refreshToken);

/** Version 2: the token names its session and generation, and the session row holds the latest. */
const rotateGeneration = async (
  tx: UltraDb,
  config: UltraConfig,
  refreshToken: string,
) => {
  // A forged or garbled token stops here, before any read or write.
  const claimed = parseRefresh(config, refreshToken);
  if (!claimed) return null;
  const session = await lockSession(tx, claimed.sessionId);
  const now = Date.now();
  if (!session || !isLive(session, now) || session.refresh_generation === null)
    return null;
  const current = Number(session.refresh_generation);
  if (claimed.generation > current) return null;
  if (claimed.generation < current) {
    await revokeForReuse(tx, session.id);
    return null;
  }
  if (current >= MAX_REFRESH_GENERATION) return null;
  return advance(tx, config, session, current + 1, now);
};

/**
 * A random 43-character token issued before generations existed. Its single receipt row decides:
 * used means reuse. The first rotation moves the session to generation 0 and from then on it
 * holds version 2 tokens only. The session row is locked before the receipt, so two rotations of
 * one session queue instead of deadlocking.
 */
const rotateLegacy = async (tx: UltraDb, config: UltraConfig, refreshToken: string) => {
  const hash = digest(refreshToken);
  const found = await one<{ session_id: string }>(
    tx,
    Prisma.sql`SELECT session_id FROM ultra_refresh_tokens WHERE digest=${hash}`,
  );
  if (!found) return null;
  const session = await lockSession(tx, found.session_id);
  const receipt = await one<{ used: boolean }>(
    tx,
    Prisma.sql`SELECT used FROM ultra_refresh_tokens WHERE digest=${hash} AND session_id=${found.session_id} FOR UPDATE`,
  );
  const now = Date.now();
  if (!session || !receipt || !isLive(session, now)) return null;
  if (receipt.used) {
    await revokeForReuse(tx, session.id);
    return null;
  }
  // A live legacy token cannot belong to a session that already holds generations. Never let one
  // reset a counter: that would make older version 2 tokens valid again.
  if (session.refresh_generation !== null) return null;
  await tx.$executeRaw(
    Prisma.sql`UPDATE ultra_refresh_tokens SET used=true WHERE digest=${hash}`,
  );
  return advance(tx, config, session, 0, now);
};
export const authenticateAccount = async (
  db: UltraDb,
  config: UltraConfig,
  authorization?: string,
): Promise<SessionRow> => {
  if (!authorization?.startsWith('Bearer ')) throw new AccountError(401);
  const accessToken = authorization.slice(7);
  if (accessToken.startsWith(BETTER_AUTH_TOKEN_PREFIX)) {
    if (config.authEngine !== 'better-auth') throw new AccountError(401);
    const session = await withAccountStore(
      authenticateBetterAuth(db, config, accessToken),
    );
    if (!session) throw new AccountError(401);
    return session;
  }

  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(accessToken, config.authSecret, {
      algorithms: ['HS256'],
      audience: 'ultra-account-v2',
      issuer: config.serverId,
    });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) throw new AccountError(401);
    throw error;
  }
  if (
    typeof decoded === 'string' ||
    typeof decoded.sid !== 'string' ||
    typeof decoded.sub !== 'string'
  )
    throw new AccountError(401);
  const row = await withAccountStore(
    one<SessionRow>(
      db,
      Prisma.sql`SELECT * FROM ultra_sessions WHERE id=${decoded.sid} AND account_id=${decoded.sub} AND revoked=false AND expires_at>${BigInt(Date.now())} AND idle_expires_at>${BigInt(Date.now())}`,
    ),
  );
  if (!row) throw new AccountError(401);
  return row;
};
export const requireRecent = (session: SessionRow): void => {
  if (Date.now() - Number(session.auth_at) > 600000)
    throw new AccountError(403, 'Sign in again before changing account security');
};

const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const newTotpSecret = (): string => {
  let bits = '';
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, '0');
  return bits
    .match(/.{5}/g)!
    .map((group) => base32[parseInt(group, 2)])
    .join('');
};
export const totp = (secret: string, step = Math.floor(Date.now() / 30000)): string => {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error('Invalid TOTP secret');
  const bits = Array.from(secret)
    .map((char) => base32.indexOf(char).toString(2).padStart(5, '0'))
    .join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((part) => parseInt(part, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', key).update(counter).digest();
  return ((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, '0');
};
export const totpStep = (
  secret: string,
  code: string,
  lastStep = -1,
): number | undefined => {
  if (!/^\d{6}$/.test(code)) return undefined;
  const now = Math.floor(Date.now() / 30000);
  return [now, now - 1, now + 1].find(
    (step) =>
      step > lastStep &&
      timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code)),
  );
};
export const mfaCodes = async (db: UltraDb, accountId: string): Promise<string[]> => {
  const codes = Array.from(
    { length: 10 },
    () => 'UTMFA-' + randomBytes(12).toString('hex').toUpperCase(),
  );
  await db.$executeRaw(
    Prisma.sql`DELETE FROM ultra_recovery_codes WHERE account_id=${accountId}`,
  );
  for (const code of codes)
    await db.$executeRaw(
      Prisma.sql`INSERT INTO ultra_recovery_codes(digest,account_id) VALUES (${digest(code)},${accountId})`,
    );
  return codes;
};
export const verifyMfaCode = async (
  db: UltraDb,
  config: UltraConfig,
  accountId: string,
  code: string,
): Promise<boolean> => {
  const codeRow = await one(
    db,
    Prisma.sql`DELETE FROM ultra_recovery_codes WHERE digest=${digest(code.trim().toUpperCase())} AND account_id=${accountId} RETURNING digest`,
  );
  if (codeRow) return true;
  const rows = await db.$queryRaw<
    { id: string; data: { encrypted: string }; last_step: bigint }[]
  >(
    Prisma.sql`SELECT id,data,last_step FROM ultra_factors WHERE account_id=${accountId} AND kind='totp' AND enabled=true`,
  );
  for (const row of rows) {
    const secret = await decodePrivate<string>(config, row.id, row.data.encrypted);
    const step = totpStep(secret, code, Number(row.last_step));
    if (
      step !== undefined &&
      (await db.$executeRaw(
        Prisma.sql`UPDATE ultra_factors SET last_step=${BigInt(step)} WHERE id=${row.id} AND last_step<${BigInt(step)}`,
      ))
    )
      return true;
  }
  return false;
};
