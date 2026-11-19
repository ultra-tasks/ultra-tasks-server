import type { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  AccountError,
  assertSessionCapacity,
  digest,
  lockAccount,
  requireLiveSession,
  requireRecent,
  verifyMfaCode,
  type UltraConfig,
} from './security';
import {
  factors,
  one,
  type AccountRow,
  type SessionRow,
  type UltraDb,
  type UltraTransaction,
} from './store';
import { openSession } from './device-login';
import {
  consumeDeviceChallenge,
  deliverDeviceCode,
  DEVICE_CHALLENGE,
  forgetDevicesExcept,
  listTrustedDevices,
  resendDeviceChallenge,
  revokeDevice,
} from './device-store';

const challengeToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
type Handler = (req: FastifyRequest) => Promise<unknown>;

/**
 * Device verification, the new-device setting and the trusted-device list. Registered like
 * the browser login routes so routes.ts keeps only the sign-in decision itself.
 */
export const registerDeviceRoutes = ({
  db,
  transaction,
  config,
  deviceEmail,
  sendMail,
  auth,
  route,
}: {
  db: UltraDb;
  transaction: UltraTransaction;
  config: UltraConfig;
  /** Feature switch: false after the operator kill switch, or without mail. */
  deviceEmail: boolean;
  sendMail: (email: string, kind: 'device', code: string) => Promise<boolean>;
  auth: (req: FastifyRequest) => Promise<SessionRow>;
  route: (method: 'GET' | 'POST', url: string, handler: Handler, max?: number) => void;
}): void => {
  /** The challenge names its account; the account row is then locked before the challenge. */
  const lockForChallenge = async (
    tx: UltraDb,
    value: string,
  ): Promise<AccountRow | undefined> => {
    const named = await one<{ account_id: string | null }>(
      tx,
      Prisma.sql`SELECT account_id FROM ultra_challenges WHERE digest=${digest(value)} AND kind=${DEVICE_CHALLENGE}`,
    );
    if (!named?.account_id) return undefined;
    const account = await one<AccountRow>(
      tx,
      Prisma.sql`SELECT * FROM ultra_accounts WHERE id=${named.account_id} FOR UPDATE`,
    );
    return account?.verified ? account : undefined;
  };

  route(
    'POST',
    '/login/device/verify',
    async (req) => {
      const input = z
        .object({ token: challengeToken, code: z.string().regex(/^\d{8}$/) })
        .strict()
        .parse(req.body);
      const result = await transaction(async (tx) => {
        const account = await lockForChallenge(tx, input.token);
        if (!account) return null;
        // Capacity is answered before the code is compared, so the answer cannot depend on it.
        await assertSessionCapacity(tx, account.id);
        // A failed attempt is counted and committed: return, never throw, from here on.
        const data = await consumeDeviceChallenge(
          tx,
          config,
          account,
          input.token,
          input.code,
        );
        // A factor enrolled since the code was sent must be satisfied by that factor, not by email.
        if (!data || (await factors(tx, account.id)).length) return null;
        return openSession(tx, config, account, data.deviceName, {
          enabled: deviceEmail,
        });
      });
      if (!result) throw new AccountError(401, 'Invalid or expired verification code');
      return result;
    },
    30,
  );

  route(
    'POST',
    '/login/device/resend',
    async (req) => {
      const { token: value } = z
        .object({ token: challengeToken })
        .strict()
        .parse(req.body);
      const next = await transaction(async (tx) => {
        const account = await lockForChallenge(tx, value);
        if (!account || (await factors(tx, account.id)).length)
          throw new AccountError(401);
        return {
          ...(await resendDeviceChallenge(tx, config, account, value)),
          email: account.email,
        };
      });
      await deliverDeviceCode(sendMail, db, next.email, next.code, value);
      return { verification: next.verification };
    },
    10,
  );

  route('POST', '/security/new-device-email', async (req) => {
    const session = await auth(req);
    requireRecent(session);
    const input = z
      .object({ enabled: z.boolean(), code: z.string().min(6).max(64).optional() })
      .strict()
      .parse(req.body);
    return transaction(async (tx) => {
      const account = await lockAccount(tx, session.account_id);
      const live = await requireLiveSession(tx, session);
      // Turning the check off with a second factor enrolled needs that factor; turning it on
      // is the safe direction, so a code that comes with it is accepted and ignored.
      if (
        !input.enabled &&
        (await factors(tx, account.id)).length &&
        !(await verifyMfaCode(tx, config, account.id, input.code ?? ''))
      )
        throw new AccountError(401);
      // Turning it back on forgets every other device: trust minted while it was off (when a
      // password alone was enough) must not outlive the opt-out. Their sessions keep running.
      if (input.enabled && !account.new_device_email)
        await forgetDevicesExcept(tx, account.id, live.device_id);
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_accounts SET new_device_email=${input.enabled} WHERE id=${account.id}`,
      );
      return { newDeviceEmailVerification: input.enabled };
    });
  });

  route(
    'GET',
    '/devices',
    async (req) => {
      const session = await auth(req);
      const rows = await listTrustedDevices(db, config, session.account_id);
      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: Number(row.created_at),
        lastSeenAt: Number(row.seen_at),
        current: row.id === session.device_id,
        sessions: Number(row.sessions),
      }));
    },
    300,
  );

  route('POST', '/devices/revoke', async (req) => {
    const session = await auth(req);
    const { deviceId, code } = z
      .object({ deviceId: z.string().uuid(), code: z.string().min(6).max(64).optional() })
      .strict()
      .parse(req.body);
    await transaction(async (tx) => {
      const account = await lockAccount(tx, session.account_id);
      const live = await requireLiveSession(tx, session);
      // Removing the device you are signed in on is always allowed. Removing another one is a
      // security change: a recent sign-in, and the second factor when one is enrolled, so a
      // stolen refresh session cannot strip the owner's other devices.
      if (deviceId !== live.device_id) {
        requireRecent(live);
        if (
          (await factors(tx, account.id)).length &&
          !(await verifyMfaCode(tx, config, account.id, code ?? ''))
        )
          throw new AccountError(401);
      }
      await revokeDevice(tx, session.account_id, deviceId);
    });
    return { revoked: true };
  });
};
