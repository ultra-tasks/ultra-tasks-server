import type { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import {
  AccountError,
  challenge,
  decodePrivate,
  digest,
  encodePrivate,
  issueSession,
  readChallenge,
  type UltraConfig,
} from './security';
import {
  accountById,
  factors,
  one,
  type AccountRow,
  type UltraDb,
  type UltraTransaction,
} from './store';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
interface BrowserMfa {
  mfaToken: string;
  proofHash: string;
  vaultVersion: number;
  deviceName: string;
  challenge?: string;
  approvedFactor?: string;
}
export const registerBrowserMfa = (options: {
  db: UltraDb;
  transaction: UltraTransaction;
  config: UltraConfig;
  post: (
    url: string,
    run: (req: FastifyRequest) => Promise<unknown>,
    max?: number,
  ) => void;
}): void => {
  const { db, transaction, config, post } = options;
  const read = async (tx: UltraDb, ticket: string) => {
    const identity = await one<{ account_id: string }>(
      tx,
      Prisma.sql`SELECT account_id FROM ultra_challenges WHERE digest=${digest(ticket)} AND kind='mfa-browser'`,
    );
    if (!identity) throw new AccountError(401);
    const account = await one<AccountRow>(
      tx,
      Prisma.sql`SELECT * FROM ultra_accounts WHERE id=${identity.account_id} FOR UPDATE`,
    );
    const row = await one<{ account_id: string; data: unknown }>(
      tx,
      Prisma.sql`SELECT account_id,data FROM ultra_challenges WHERE digest=${digest(ticket)} AND kind='mfa-browser' AND expires_at>${BigInt(Date.now())} AND attempts<5 FOR UPDATE`,
    );
    if (!row) throw new AccountError(401);
    const data = await decodePrivate<BrowserMfa>(config, digest(ticket), row.data);
    if (
      !account ||
      account.vault_version !== data.vaultVersion ||
      !(await one(
        tx,
        Prisma.sql`SELECT digest FROM ultra_challenges WHERE digest=${digest(data.mfaToken)} AND account_id=${row.account_id} AND kind='mfa' AND expires_at>${BigInt(Date.now())}`,
      ))
    )
      throw new AccountError(401);
    return { accountId: row.account_id, data };
  };
  const update = async (tx: UltraDb, ticket: string, data: BrowserMfa) =>
    tx.$executeRaw(
      Prisma.sql`UPDATE ultra_challenges SET data=${JSON.stringify(await encodePrivate(config, digest(ticket), data))}::jsonb WHERE digest=${digest(ticket)} AND kind='mfa-browser'`,
    );
  post('/mfa/browser/start', async (req) => {
    const input = z
      .object({ mfaToken: token, proofHash: token })
      .strict()
      .parse(req.body);
    return transaction(async (tx) => {
      const pending = await readChallenge<{ deviceName: string }>(
        tx,
        config,
        input.mfaToken,
        'mfa',
      );
      const account = await accountById(tx, pending.accountId!);
      if (!account || !(await factors(tx, account.id)).some((f) => f.kind === 'webauthn'))
        throw new AccountError(401);
      const ticket = await challenge(
        tx,
        config,
        'mfa-browser',
        account.id,
        {
          mfaToken: input.mfaToken,
          proofHash: input.proofHash,
          vaultVersion: account.vault_version,
          deviceName: pending.data.deviceName,
        } satisfies BrowserMfa,
        180000,
      );
      return {
        ticket,
        url: config.publicUrl + '/account?device=' + ticket,
        expiresIn: 180,
      };
    });
  });
  post('/mfa/browser/options', async (req) => {
    const { ticket } = z.object({ ticket: token }).strict().parse(req.body);
    return transaction(async (tx) => {
      const pending = await read(tx, ticket);
      if (pending.data.approvedFactor) throw new AccountError(409);
      const enrolled = (await factors(tx, pending.accountId)).filter(
        (f) => f.kind === 'webauthn',
      );
      if (!enrolled.length) throw new AccountError(401);
      const options = await generateAuthenticationOptions({
        rpID: config.rpId,
        allowCredentials: enrolled.map((f) => ({ id: String(f.data.id) })),
        userVerification: 'required',
      });
      await update(tx, ticket, { ...pending.data, challenge: options.challenge });
      return { options, deviceName: pending.data.deviceName };
    });
  });
  post('/mfa/browser/approve', async (req) => {
    const input = z
      .object({
        ticket: token,
        credential: z.custom<AuthenticationResponseJSON>(
          (v) => !!v && typeof v === 'object',
        ),
      })
      .strict()
      .parse(req.body);
    return transaction(async (tx) => {
      const pending = await read(tx, input.ticket);
      if (!pending.data.challenge || pending.data.approvedFactor)
        throw new AccountError(409);
      const factor = (await factors(tx, pending.accountId)).find(
        (f) => f.kind === 'webauthn' && f.data.id === input.credential.id,
      );
      if (!factor) throw new AccountError(401);
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response: input.credential,
          expectedChallenge: pending.data.challenge,
          expectedOrigin: config.publicUrl,
          expectedRPID: config.rpId,
          requireUserVerification: true,
          credential: {
            id: String(factor.data.id),
            publicKey: new Uint8Array(
              Buffer.from(String(factor.data.publicKey), 'base64url'),
            ),
            counter: Number(factor.data.counter),
          },
        });
      } catch {
        throw new AccountError(401);
      }
      if (!result.verified) throw new AccountError(401);
      const count = await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_factors SET data=${JSON.stringify({ ...factor.data, counter: result.authenticationInfo.newCounter })}::jsonb WHERE id=${factor.id} AND enabled=true AND data=${JSON.stringify(factor.data)}::jsonb`,
      );
      if (!count) throw new AccountError(401);
      const { challenge: _challenge, ...data } = pending.data;
      await update(tx, input.ticket, { ...data, approvedFactor: factor.id });
      return { approved: true };
    });
  });
  post(
    '/mfa/browser/poll',
    async (req) => {
      const input = z
        .object({ ticket: token, deviceSecret: token })
        .strict()
        .parse(req.body);
      const result = await transaction(async (tx) => {
        const pending = await read(tx, input.ticket);
        const hash = createHash('sha256').update(input.deviceSecret).digest('base64url');
        if (!timingSafeEqual(Buffer.from(hash), Buffer.from(pending.data.proofHash))) {
          await tx.$executeRaw(
            Prisma.sql`UPDATE ultra_challenges SET attempts=attempts+1 WHERE digest=${digest(input.ticket)}`,
          );
          return { invalid: true };
        }
        if (!pending.data.approvedFactor) return { pending: true };
        if (
          !(await factors(tx, pending.accountId)).some(
            (f) => f.id === pending.data.approvedFactor,
          )
        )
          throw new AccountError(401);
        const login = await readChallenge<{ deviceName: string }>(
          tx,
          config,
          pending.data.mfaToken,
          'mfa',
          true,
        );
        if (login.accountId !== pending.accountId) throw new AccountError(401);
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM ultra_challenges WHERE digest=${digest(input.ticket)}`,
        );
        return issueSession(tx, config, pending.accountId, login.data.deviceName);
      });
      if ('invalid' in result) throw new AccountError(401);
      return result;
    },
    600,
  );
};
