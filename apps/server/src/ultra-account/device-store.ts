import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  AccountError,
  decodePrivate,
  digest,
  encodePrivate,
  issueSession,
  sessionIdleMs,
  token,
  type UltraConfig,
} from './security';
import { factors, one, type AccountRow, type SessionRow, type UltraDb } from './store';

/**
 * Trusted devices and the new-device email challenge. See
 * docs/account-devices-and-sessions.md for the design, limits and threat model.
 */
export const DEVICE_CHALLENGE = 'device-email';
export const DEVICE_CHALLENGE_TTL = 10 * 60 * 1000;
export const DEVICE_MAX_ATTEMPTS = 5;
export const DEVICE_RESEND_COOLDOWN = 30 * 1000;
export const DEVICE_MAX_RESENDS = 3;
export const MAX_TRUSTED_DEVICES = 30;
/** Emails (first codes and resends together) one account may be sent per window. */
export const DEVICE_MAIL_LIMIT = 12;
export const DEVICE_MAIL_WINDOW = 60 * 60 * 1000;
/**
 * Pending challenges per account. Equal to the hourly email budget on purpose: every challenge
 * costs one email, so the budget refuses the thirteenth before a pending one could ever be
 * evicted. Nobody, not even a password holder, can push the owner's pending code out; they can
 * only spend the budget (see spendDeviceMail).
 */
export const DEVICE_MAX_PENDING = DEVICE_MAIL_LIMIT;
// Literals rather than bound parameters: the constants are trusted and need no cast.
const KEEP_OTHER_DEVICES = Prisma.raw(String(MAX_TRUSTED_DEVICES - 1));
const KEEP_OTHER_CHALLENGES = Prisma.raw(String(DEVICE_MAX_PENDING - 1));
const ATTEMPTS_LIMIT = Prisma.raw(String(DEVICE_MAX_ATTEMPTS));

/** What a sign-in request told the server about the calling device. */
export interface DeviceTrust {
  /** The client declared `deviceEmail` and the feature is on: record or refresh the device. */
  enabled: boolean;
  /** SHA-256 digest of the device token the client presented, if any. */
  digest?: string;
}
export const deviceTrustFrom = (
  input: { deviceToken?: string; clientFeatures?: string[] },
  featureOn: boolean,
): DeviceTrust => ({
  enabled: featureOn && !!input.clientFeatures?.includes('deviceEmail'),
  digest: input.deviceToken ? digest(input.deviceToken) : undefined,
});

export interface DeviceChallengeData {
  deviceName: string;
  /** HMAC of the code, bound to this challenge and account; the code itself is never stored. */
  codeHmac: string;
  resends: number;
  /** Earliest time another code may be requested. */
  resendAt: number;
}
export interface DeviceVerification {
  kind: 'email';
  token: string;
  expiresIn: number;
  resendAfter: number;
  resendsLeft: number;
  emailHint: string;
}

/**
 * A device label is whatever name the client chose; it is shown to the owner in Devices and is
 * never trust evidence. Control and bidirectional-override characters are replaced so a label
 * cannot reorder or hide the text around it.
 */
export const deviceLabel = (name: string): string =>
  name
    .replace(/[\p{Cc}\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'This device';

const newCode = (): string => randomInt(0, 100000000).toString().padStart(8, '0');
const codeHmac = (
  config: UltraConfig,
  challengeDigest: string,
  accountId: string,
  code: string,
): string =>
  createHmac('sha256', config.authSecret)
    .update(`device-email-v1\0${challengeDigest}\0${accountId}\0${code}`)
    .digest('hex');
const sameHmac = (stored: string, candidate: string): boolean =>
  stored.length === candidate.length &&
  timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(candidate, 'hex'));
/** `d***@example.test`: enough to find the inbox, shown only after the password proof. */
export const emailHint = (email: string): string => {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${email[0]}***${email.slice(at)}`;
};
const verificationFor = (
  email: string,
  value: string,
  expiresAt: number,
  data: DeviceChallengeData,
  now: number,
): DeviceVerification => ({
  kind: 'email',
  token: value,
  expiresIn: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
  resendAfter: DEVICE_RESEND_COOLDOWN / 1000,
  resendsLeft: Math.max(0, DEVICE_MAX_RESENDS - data.resends),
  emailHint: emailHint(email),
});

/* ---------------------------- trusted devices ---------------------------- */

/**
 * A device counts as recently active when it signed in, or one of its sessions refreshed, inside
 * the session idle window. A refresh renews the session, not the device row, so activity is read
 * from both.
 */
const deviceActivity = Prisma.raw(
  'GREATEST(d.last_seen_at, COALESCE((SELECT max(GREATEST(s.created_at, s.refreshed_at)) FROM ultra_sessions s WHERE s.device_id=d.id), 0))',
);
/**
 * Recognises a device token for this account while it is active inside the idle window. Trust
 * therefore follows use: a device untouched for the whole window is asked once more. A removed
 * device has no row at all (the `revoked` column is kept for compatibility and never read).
 */
export const findTrustedDevice = (
  db: UltraDb,
  config: UltraConfig,
  accountId: string,
  tokenDigest: string,
) =>
  one<{ id: string }>(
    db,
    Prisma.sql`SELECT d.id FROM ultra_devices d WHERE d.token_digest=${tokenDigest} AND d.account_id=${accountId} AND ${deviceActivity}>${BigInt(Date.now() - sessionIdleMs(config))}`,
  );
/** Devices still inside the idle window, most recently active first. */
export const listTrustedDevices = (
  db: UltraDb,
  config: UltraConfig,
  accountId: string,
) => {
  const now = BigInt(Date.now());
  return db.$queryRaw<
    {
      id: string;
      label: string;
      created_at: bigint;
      seen_at: bigint;
      sessions: bigint;
    }[]
  >(
    Prisma.sql`SELECT d.id,d.label,d.created_at,${deviceActivity} AS seen_at,
      (SELECT count(*) FROM ultra_sessions s WHERE s.device_id=d.id AND s.revoked=false AND s.expires_at>${now} AND s.idle_expires_at>${now}) AS sessions
      FROM ultra_devices d WHERE d.account_id=${accountId} AND ${deviceActivity}>${BigInt(Date.now() - sessionIdleMs(config))}
      ORDER BY seen_at DESC, d.created_at DESC`,
  );
};
/** A session is trusted while its device record exists. */
export const sessionIsTrusted = async (
  db: UltraDb,
  session: Pick<SessionRow, 'account_id' | 'device_id'>,
): Promise<boolean> =>
  !!session.device_id &&
  !!(await one(
    db,
    Prisma.sql`SELECT id FROM ultra_devices WHERE id=${session.device_id} AND account_id=${session.account_id}`,
  ));
/**
 * Keeps the new record plus the 29 most recently active others and deletes the rest. A device in
 * daily use through a long-lived session counts by its sessions' refresh times, not only by when
 * it last signed in.
 */
const pruneDevices = (tx: UltraDb, accountId: string, keepId: string) =>
  tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_devices WHERE id IN (
      SELECT d.id FROM ultra_devices d WHERE d.account_id=${accountId} AND d.id<>${keepId}
      ORDER BY ${deviceActivity} DESC, d.id
      OFFSET ${KEEP_OTHER_DEVICES})`,
  );
/** Deletes this account's devices whose trust has lapsed: unused for the whole idle window. */
export const purgeLapsedDevices = (tx: UltraDb, config: UltraConfig, accountId: string) =>
  tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_devices d WHERE d.account_id=${accountId} AND ${deviceActivity}<=${BigInt(Date.now() - sessionIdleMs(config))}`,
  );
/**
 * Records the device behind a sign-in whose policy was satisfied. A recognised token keeps
 * its record (and is not echoed or rotated); anything else gets a new record and token.
 */
export const trustDevice = async (
  tx: UltraDb,
  config: UltraConfig,
  accountId: string,
  label: string,
  presentedDigest?: string,
): Promise<{ id: string; token?: string }> => {
  const now = BigInt(Date.now());
  const shown = deviceLabel(label);
  if (presentedDigest) {
    const known = await findTrustedDevice(tx, config, accountId, presentedDigest);
    if (known) {
      // Only the activity time moves: a sign-in must not be able to rename a trusted device.
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_devices SET last_seen_at=${now} WHERE id=${known.id}`,
      );
      return { id: known.id };
    }
  }
  const value = token();
  const id = randomUUID();
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO ultra_devices(id,account_id,token_digest,label,created_at,last_seen_at) VALUES (${id},${accountId},${digest(value)},${shown},${now},${now})`,
  );
  await pruneDevices(tx, accountId, id);
  return { id, token: value };
};
/**
 * Removes one device: its sessions end first, then its record is deleted, so nothing about a
 * removed device is retained (the sessions' device link becomes NULL). Idempotent.
 */
export const revokeDevice = async (tx: UltraDb, accountId: string, deviceId: string) => {
  await tx.$executeRaw(
    Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE device_id=${deviceId} AND account_id=${accountId}`,
  );
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_devices WHERE id=${deviceId} AND account_id=${accountId}`,
  );
};
/**
 * Password change keeps only the device making the change; recovery keeps none (null). Sessions
 * of the removed devices end and their records are deleted.
 */
export const revokeDevicesExcept = async (
  tx: UltraDb,
  accountId: string,
  keepId: string | null,
) => {
  await tx.$executeRaw(
    Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE account_id=${accountId} AND device_id IS NOT NULL AND device_id IS DISTINCT FROM ${keepId}`,
  );
  await forgetDevicesExcept(tx, accountId, keepId);
};
/**
 * Deletes every device record except `keepId`, leaving their sessions alive but unbound (they
 * keep syncing and cannot vouch for a new device). Used when the email check is turned back on,
 * so trust minted while it was off does not survive.
 */
export const forgetDevicesExcept = (
  tx: UltraDb,
  accountId: string,
  keepId: string | null,
) =>
  tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_devices WHERE account_id=${accountId} AND id IS DISTINCT FROM ${keepId}`,
  );

/**
 * Issues a session and, when the client declared support, records its device. Runs inside the
 * caller's transaction, so a refused session (limit reached) leaves no device record behind.
 */
export const issueTrustedSession = async (
  tx: UltraDb,
  config: UltraConfig,
  accountId: string,
  deviceName: string,
  trust: DeviceTrust,
) => {
  await purgeLapsedDevices(tx, config, accountId);
  const device = trust.enabled
    ? await trustDevice(tx, config, accountId, deviceName, trust.digest)
    : undefined;
  const tokens = await issueSession(tx, config, accountId, deviceName, {
    deviceId: device?.id,
  });
  return { tokens, deviceToken: device?.token };
};

/**
 * An approval may start a session on a new device only if the approving session itself passed
 * the policy: an enrolled factor, or a device that is still trusted. Otherwise the person signs
 * in again on that browser, which verifies the device, and retries.
 */
export const requireTrustedApprover = async (
  tx: UltraDb,
  account: AccountRow,
  session: SessionRow,
  featureOn: boolean,
): Promise<void> => {
  if (!featureOn || !account.new_device_email) return;
  if ((await factors(tx, account.id)).length) return;
  if (await sessionIsTrusted(tx, session)) return;
  throw new AccountError(
    403,
    'Sign in again on this device before approving another device.',
    'device_verification_required',
  );
};

/* ------------------------------ email challenge ------------------------------ */

export const deletePendingDeviceChallenges = (tx: UltraDb, accountId: string) =>
  tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_challenges WHERE account_id=${accountId} AND kind=${DEVICE_CHALLENGE}`,
  );
export const removeDeviceChallenge = (db: UltraDb, value: string) =>
  db.$executeRaw(Prisma.sql`DELETE FROM ultra_challenges WHERE digest=${digest(value)}`);
const readData = async (
  config: UltraConfig,
  challengeDigest: string,
  stored: unknown,
): Promise<DeviceChallengeData | undefined> => {
  try {
    return await decodePrivate<DeviceChallengeData>(config, challengeDigest, stored);
  } catch {
    return undefined;
  }
};

/**
 * Per-account bound on emailed codes (first codes and resends together): 12 per hour. It protects
 * the inbox and the operator's mail reputation from someone who has the password but not the
 * mailbox. The counter lives in one self-expiring row of the challenge table. Inside the caller's
 * transaction: a refusal leaves nothing behind. Recognised devices, MFA and sessions in use are
 * never affected.
 */
export const spendDeviceMail = async (tx: UltraDb, accountId: string): Promise<void> => {
  const now = Date.now();
  const row = await one<{ attempts: number }>(
    tx,
    Prisma.sql`INSERT INTO ultra_challenges(digest,kind,account_id,expires_at,attempts,data) VALUES (${digest('device-email-budget:' + accountId)},'device-email-budget',${accountId},${BigInt(now + DEVICE_MAIL_WINDOW)},1,'{}'::jsonb)
      ON CONFLICT (digest) DO UPDATE SET
        attempts=CASE WHEN ultra_challenges.expires_at<=${BigInt(now)} THEN 1 ELSE ultra_challenges.attempts+1 END,
        expires_at=CASE WHEN ultra_challenges.expires_at<=${BigInt(now)} THEN ${BigInt(now + DEVICE_MAIL_WINDOW)} ELSE ultra_challenges.expires_at END
      RETURNING attempts`,
  );
  if (!row || Number(row.attempts) > DEVICE_MAIL_LIMIT)
    throw new AccountError(
      429,
      'Too many verification emails were requested for this account. Try again later.',
      'verification_rate_limited',
    );
};

/** Creates the challenge. The caller sends `code` after the transaction commits. */
export const startDeviceChallenge = async (
  tx: UltraDb,
  config: UltraConfig,
  account: AccountRow,
  deviceName: string,
) => {
  const now = Date.now();
  await spendDeviceMail(tx, account.id);
  const value = token();
  const challengeDigest = digest(value);
  const code = newCode();
  const data: DeviceChallengeData = {
    deviceName,
    codeHmac: codeHmac(config, challengeDigest, account.id, code),
    resends: 0,
    resendAt: now + DEVICE_RESEND_COOLDOWN,
  };
  const expiresAt = now + DEVICE_CHALLENGE_TTL;
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_challenges WHERE expires_at<${BigInt(now)}`,
  );
  // At most DEVICE_MAX_PENDING per account: the newest always wins over the oldest.
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_challenges WHERE digest IN (SELECT digest FROM ultra_challenges WHERE account_id=${account.id} AND kind=${DEVICE_CHALLENGE} ORDER BY expires_at DESC OFFSET ${KEEP_OTHER_CHALLENGES})`,
  );
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO ultra_challenges(digest,kind,account_id,expires_at,data) VALUES (${challengeDigest},${DEVICE_CHALLENGE},${account.id},${BigInt(expiresAt)},${JSON.stringify(await encodePrivate(config, challengeDigest, data))}::jsonb)`,
  );
  return {
    token: value,
    code,
    verification: verificationFor(account.email, value, expiresAt, data, now),
  };
};

/**
 * Checks and consumes a code inside the account-locked transaction. The attempt is counted
 * before the comparison and committed even when it fails, so the caller must return (not throw)
 * from the transaction on `undefined`. Every failure is indistinguishable to the client.
 */
export const consumeDeviceChallenge = async (
  tx: UltraDb,
  config: UltraConfig,
  account: AccountRow,
  value: string,
  code: string,
): Promise<DeviceChallengeData | undefined> => {
  const challengeDigest = digest(value);
  const row = await one<{ data: unknown }>(
    tx,
    Prisma.sql`UPDATE ultra_challenges SET attempts=attempts+1 WHERE digest=${challengeDigest} AND kind=${DEVICE_CHALLENGE} AND account_id=${account.id} AND expires_at>${BigInt(Date.now())} AND attempts<${ATTEMPTS_LIMIT} RETURNING data`,
  );
  if (!row) return undefined;
  const data = await readData(config, challengeDigest, row.data);
  if (
    !data ||
    !sameHmac(data.codeHmac, codeHmac(config, challengeDigest, account.id, code))
  )
    return undefined;
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_challenges WHERE digest=${challengeDigest}`,
  );
  return data;
};

/** Replaces the code in the same row, so the attempt budget and the expiry carry over. */
export const resendDeviceChallenge = async (
  tx: UltraDb,
  config: UltraConfig,
  account: AccountRow,
  value: string,
) => {
  const now = Date.now();
  const challengeDigest = digest(value);
  const row = await one<{ data: unknown; expires_at: bigint }>(
    tx,
    Prisma.sql`SELECT data,expires_at FROM ultra_challenges WHERE digest=${challengeDigest} AND kind=${DEVICE_CHALLENGE} AND account_id=${account.id} AND expires_at>${BigInt(now)} AND attempts<${ATTEMPTS_LIMIT} FOR UPDATE`,
  );
  const data = row && (await readData(config, challengeDigest, row.data));
  if (!row || !data) throw new AccountError(401);
  if (data.resends >= DEVICE_MAX_RESENDS)
    throw new AccountError(
      429,
      'No more codes can be sent for this sign-in. Sign in again.',
      'resend_limit',
    );
  if (data.resendAt > now)
    throw new AccountError(
      429,
      'Wait a moment before requesting another code.',
      'resend_too_soon',
    );
  await spendDeviceMail(tx, account.id);
  const code = newCode();
  const next: DeviceChallengeData = {
    ...data,
    codeHmac: codeHmac(config, challengeDigest, account.id, code),
    resends: data.resends + 1,
    resendAt: now + DEVICE_RESEND_COOLDOWN,
  };
  await tx.$executeRaw(
    Prisma.sql`UPDATE ultra_challenges SET data=${JSON.stringify(await encodePrivate(config, challengeDigest, next))}::jsonb WHERE digest=${challengeDigest}`,
  );
  return {
    code,
    verification: verificationFor(
      account.email,
      value,
      Number(row.expires_at),
      next,
      now,
    ),
  };
};

/**
 * Sends the code after the database transaction committed, so a slow mail provider never holds
 * the account lock. A failed send removes the challenge: no session, and no code the user never saw.
 */
export const deliverDeviceCode = async (
  sendMail: (email: string, kind: 'device', code: string) => Promise<boolean>,
  db: UltraDb,
  email: string,
  code: string,
  value: string,
): Promise<void> => {
  let sent = false;
  try {
    sent = await sendMail(email, 'device', code);
  } catch {
    sent = false;
  }
  if (sent) return;
  await removeDeviceChallenge(db, value);
  throw new AccountError(
    503,
    'Email could not be delivered. Please try again.',
    'email_delivery_failed',
  );
};
