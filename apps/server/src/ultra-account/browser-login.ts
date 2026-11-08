import type { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  BROWSER_LOGIN_RETURNS,
  browserLoginSignedData,
  fingerprint,
  verify,
  type BrowserLoginRequest,
  type BrowserLoginApproval,
} from '@ultra-tasks/account-crypto';
import {
  AccountError,
  authenticateAccount,
  challenge,
  decodePrivate,
  digest,
  encodePrivate,
  issueSession,
  requireRecent,
  type UltraConfig,
} from './security';
import {
  one,
  factors,
  type AccountRow,
  type SessionRow,
  type UltraDb,
  type UltraTransaction,
} from './store';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const publicKey = z
  .object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: token, y: token })
  .strict();
const proof = z
  .object({ ticket: token, state: token, verifier: token, serverId: z.string().uuid() })
  .strict();
interface StoredRequest {
  request: BrowserLoginRequest;
  approval?: BrowserLoginApproval;
  sessionId?: string;
  factorIds?: string[];
}
interface RequestRow {
  account_id: string | null;
  data: unknown;
}
export const registerBrowserLogin = ({
  db,
  transaction,
  config,
  post,
}: {
  db: UltraDb;
  transaction: UltraTransaction;
  config: UltraConfig;
  post: (
    url: string,
    run: (req: FastifyRequest) => Promise<unknown>,
    max?: number,
  ) => void;
}): void => {
  const read = async (tx: UltraDb, ticket: string, lock = false) => {
    const row = await one<RequestRow>(
      tx,
      lock
        ? Prisma.sql`SELECT account_id,data FROM ultra_challenges WHERE digest=${digest(ticket)} AND kind='browser-login' AND expires_at>${BigInt(Date.now())} FOR UPDATE`
        : Prisma.sql`SELECT account_id,data FROM ultra_challenges WHERE digest=${digest(ticket)} AND kind='browser-login' AND expires_at>${BigInt(Date.now())}`,
    );
    if (!row) throw new AccountError(401);
    const data = await decodePrivate<StoredRequest>(config, digest(ticket), row.data);
    if (data.request.expiresAt <= Date.now() || data.request.serverId !== config.serverId)
      throw new AccountError(401);
    return { row, data };
  };
  const save = async (
    tx: UltraDb,
    ticket: string,
    data: StoredRequest,
    accountId: string | null,
  ) =>
    tx.$executeRaw(
      Prisma.sql`UPDATE ultra_challenges SET account_id=${accountId},data=${JSON.stringify(await encodePrivate(config, digest(ticket), data))}::jsonb WHERE digest=${digest(ticket)} AND kind='browser-login'`,
    );
  const remove = (tx: UltraDb, ticket: string) =>
    tx.$executeRaw(
      Prisma.sql`DELETE FROM ultra_challenges WHERE digest=${digest(ticket)} AND kind='browser-login'`,
    );
  const checkProof = (input: z.infer<typeof proof>, request: BrowserLoginRequest) => {
    const hash = createHash('sha256').update(input.verifier).digest('base64url');
    if (
      input.serverId !== config.serverId ||
      input.state !== request.state ||
      !timingSafeEqual(Buffer.from(hash), Buffer.from(request.proofHash))
    )
      throw new AccountError(401);
  };
  const lockAccount = async (tx: UltraDb, id: string) => {
    const account = await one<AccountRow>(
      tx,
      Prisma.sql`SELECT * FROM ultra_accounts WHERE id=${id} FOR UPDATE`,
    );
    if (!account?.verified) throw new AccountError(401);
    return account;
  };
  const liveSession = async (tx: UltraDb, accountId: string, id: string) => {
    const session = await one<SessionRow>(
      tx,
      Prisma.sql`SELECT * FROM ultra_sessions WHERE id=${id} AND account_id=${accountId} AND revoked=false AND expires_at>${BigInt(Date.now())} AND idle_expires_at>${BigInt(Date.now())} FOR UPDATE`,
    );
    if (!session) throw new AccountError(401);
    return session;
  };
  post('/browser-login/start', async (req) => {
    const input = z
      .object({
        v: z.literal(1),
        serverId: z.string().uuid(),
        serverUrl: z.string().url().max(2048),
        state: token,
        proofHash: token,
        publicKey,
        redirectUri: z.enum(BROWSER_LOGIN_RETURNS),
        deviceName: z.string().trim().min(1).max(100),
        identifier: z.string().trim().toLowerCase().min(1).max(254).optional(),
      })
      .strict()
      .parse(req.body);
    if (
      input.serverId !== config.serverId ||
      input.serverUrl !== config.publicUrl.replace(/\/$/, '')
    )
      throw new AccountError(400, 'Account server identity changed');
    return transaction(async (tx) => {
      const expiresAt = Date.now() + 300000;
      const ticket = await challenge(tx, config, 'browser-login', null, {}, 300000);
      const request: BrowserLoginRequest = { ...input, ticket, expiresAt };
      await save(tx, ticket, { request }, null);
      return request;
    });
  });
  post(
    '/browser-login/info',
    async (req) => {
      const { ticket } = z.object({ ticket: token }).strict().parse(req.body);
      return (await read(db, ticket)).data.request;
    },
    120,
  );
  post('/browser-login/approve', async (req) => {
    const session = await authenticateAccount(db, config, req.headers.authorization);
    requireRecent(session);
    const input = z
      .object({
        ticket: token,
        accountId: z.string().uuid(),
        vaultVersion: z.number().int().positive(),
        bundleHash: token,
        grant: z
          .object({
            v: z.literal(1),
            enc: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .max(256),
            data: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .max(256),
          })
          .strict(),
        signature: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .max(256),
      })
      .strict()
      .parse(req.body);
    return transaction(async (tx) => {
      const account = await lockAccount(tx, session.account_id);
      await liveSession(tx, account.id, session.id);
      const { data } = await read(tx, input.ticket, true);
      if (data.approval) throw new AccountError(409);
      if (
        data.request.identifier &&
        ![account.email, account.username].includes(data.request.identifier)
      )
        throw new AccountError(403, 'Use the account requested by the app');
      const { ticket: _ticket, signature, ...approval } = input;
      if (
        input.accountId !== account.id ||
        input.vaultVersion !== account.vault_version ||
        input.bundleHash !== (await fingerprint(account.bundle)) ||
        !(await verify(
          account.bundle.signingPublicKey,
          browserLoginSignedData(data.request, approval),
          signature,
        ))
      )
        throw new AccountError(401);
      await save(
        tx,
        input.ticket,
        {
          ...data,
          approval: { ...approval, signature },
          sessionId: session.id,
          factorIds: (await factors(tx, account.id)).map((f) => f.id),
        },
        account.id,
      );
      return { approved: true };
    });
  });
  post(
    '/browser-login/poll',
    async (req) => {
      const input = proof.parse(req.body);
      return transaction(async (tx) => {
        // Account before challenge before session: the same order as account security changes.
        const identity = await one<{ account_id: string | null }>(
          tx,
          Prisma.sql`SELECT account_id FROM ultra_challenges WHERE digest=${digest(input.ticket)} AND kind='browser-login'`,
        );
        if (!identity) throw new AccountError(401);
        const account = identity.account_id
          ? await lockAccount(tx, identity.account_id)
          : undefined;
        const { row, data } = await read(tx, input.ticket, true);
        checkProof(input, data.request);
        if (!data.approval || !account || row.account_id !== account.id)
          return { pending: true };
        await liveSession(tx, account.id, data.sessionId!);
        if (
          account.vault_version !== data.approval.vaultVersion ||
          (await fingerprint(account.bundle)) !== data.approval.bundleHash ||
          JSON.stringify((await factors(tx, account.id)).map((f) => f.id)) !==
            JSON.stringify(data.factorIds)
        )
          throw new AccountError(401);
        await remove(tx, input.ticket);
        const tokens = await issueSession(
          tx,
          config,
          account.id,
          data.request.deviceName,
        );
        return { request: data.request, approval: data.approval, tokens };
      });
    },
    600,
  );
  post(
    '/browser-login/cancel',
    async (req) => {
      const input = proof.parse(req.body);
      return transaction(async (tx) => {
        const { data } = await read(tx, input.ticket, true);
        checkProof(input, data.request);
        await remove(tx, input.ticket);
        return { canceled: true };
      });
    },
    120,
  );
  post('/browser-login/deny', async (req) => {
    const session = await authenticateAccount(db, config, req.headers.authorization);
    const { ticket } = z.object({ ticket: token }).strict().parse(req.body);
    return transaction(async (tx) => {
      await lockAccount(tx, session.account_id);
      await liveSession(tx, session.account_id, session.id);
      const { row } = await read(tx, ticket, true);
      if (row.account_id && row.account_id !== session.account_id)
        throw new AccountError(403);
      await remove(tx, ticket);
      return { denied: true };
    });
  });
};
