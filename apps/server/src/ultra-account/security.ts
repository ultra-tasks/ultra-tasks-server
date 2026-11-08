import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { canonical, open, seal } from '@ultra-tasks/account-crypto';
import { SessionRow, UltraDb, one } from './store';
import {
  authenticateBetterAuth,
  BETTER_AUTH_TOKEN_PREFIX,
  issueBetterAuthAccess,
} from './better-auth';

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
}
export const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const token = (): string => randomBytes(32).toString('base64url');
export class AccountError extends Error {
  constructor(
    public statusCode: number,
    message = 'Invalid or expired credentials',
  ) {
    super(message);
  }
}
export const DAY = 86400000;
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
export const issueSession = async (
  db: UltraDb,
  config: UltraConfig,
  accountId: string,
  deviceName: string,
) => {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.$executeRaw(
    Prisma.sql`DELETE FROM ultra_sessions WHERE expires_at<${BigInt(now)} OR idle_expires_at<${BigInt(now)}`,
  );
  const count = await one<{ count: bigint }>(
    db,
    Prisma.sql`SELECT count(*) AS count FROM ultra_sessions WHERE account_id=${accountId} AND revoked=false`,
  );
  if (Number(count?.count ?? 0) >= 20)
    throw new AccountError(409, 'Revoke an old device session before signing in again');
  await db.$executeRaw(
    Prisma.sql`INSERT INTO ultra_sessions(id,account_id,device_name,created_at,auth_at,expires_at,idle_expires_at) VALUES (${id},${accountId},${deviceName},${BigInt(now)},${BigInt(now)},${BigInt(now + 90 * DAY)},${BigInt(now + 30 * DAY)})`,
  );
  return issueTokens(db, config, { id, account_id: accountId });
};
export const issueTokens = async (
  db: UltraDb,
  config: UltraConfig,
  session: Pick<SessionRow, 'id' | 'account_id'>,
) => {
  const refreshToken = token();
  await db.$executeRaw(
    Prisma.sql`INSERT INTO ultra_refresh_tokens(digest,session_id) VALUES (${digest(refreshToken)},${session.id})`,
  );
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
export const authenticateAccount = async (
  db: UltraDb,
  config: UltraConfig,
  authorization?: string,
): Promise<SessionRow> => {
  try {
    if (!authorization?.startsWith('Bearer ')) throw new Error();
    if (authorization.slice(7).startsWith(BETTER_AUTH_TOKEN_PREFIX)) {
      if (config.authEngine !== 'better-auth') throw new Error();
      const session = await authenticateBetterAuth(db, config, authorization.slice(7));
      if (!session) throw new Error();
      return session;
    }
    const decoded = jwt.verify(authorization.slice(7), config.authSecret, {
      algorithms: ['HS256'],
      audience: 'ultra-account-v2',
      issuer: config.serverId,
    });
    if (
      typeof decoded === 'string' ||
      typeof decoded.sid !== 'string' ||
      typeof decoded.sub !== 'string'
    )
      throw new Error();
    const row = await one<SessionRow>(
      db,
      Prisma.sql`SELECT * FROM ultra_sessions WHERE id=${decoded.sid} AND account_id=${decoded.sub} AND revoked=false AND expires_at>${BigInt(Date.now())} AND idle_expires_at>${BigInt(Date.now())}`,
    );
    if (!row) throw new Error();
    return row;
  } catch {
    throw new AccountError(401);
  }
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
