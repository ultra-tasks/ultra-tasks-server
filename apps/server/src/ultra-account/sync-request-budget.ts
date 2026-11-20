import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AccountError,
  accountErrorBody,
  authenticateAccount,
  type UltraConfig,
} from './security';
import type { SessionRow, UltraDb } from './store';

export interface SyncRequestLimits {
  ipPerMinute: number;
  accountPerMinute: number;
}

const DEFAULT_LIMITS: SyncRequestLimits = { ipPerMinute: 600, accountPerMinute: 480 };

export const createSyncRequestBudget = async (
  app: FastifyInstance,
  db: UltraDb,
  config: UltraConfig,
  limits = DEFAULT_LIMITS,
) => {
  // The legacy server omits its global limiter in test mode; serve the same
  // bounded native admission checks whenever the native routes are registered.
  if (!app.hasDecorator('createRateLimit'))
    await app.register(rateLimit, { global: false });

  const sessions = new WeakMap<FastifyRequest, SessionRow>();
  const verifiedAccounts = new WeakMap<FastifyRequest, string>();
  const checkIp = app.createRateLimit({
    max: limits.ipPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });
  const checkAccount = app.createRateLimit({
    max: limits.accountPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (request) => verifiedAccounts.get(request)!,
  });

  const charge = async (
    limit: typeof checkIp,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const budget = await limit(request);
    if (!budget.isAllowed && budget.isExceeded) {
      reply.header('Retry-After', String(budget.ttlInSeconds));
      throw new AccountError(
        429,
        'Too many sync requests. Try again shortly.',
        'SYNC_RATE_LIMITED',
      );
    }
  };
  const chargeAccount = async (
    request: FastifyRequest,
    reply: FastifyReply,
    accountId: string,
  ): Promise<void> => {
    verifiedAccounts.set(request, accountId);
    await charge(checkAccount, request, reply);
  };
  const admit =
    (requireAccount: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      try {
        await charge(checkIp, request, reply);
        if (requireAccount) {
          const session = await authenticateAccount(
            db,
            config,
            request.headers.authorization,
          );
          await chargeAccount(request, reply, session.account_id);
          sessions.set(request, session);
        }
      } catch (error) {
        if (!(error instanceof AccountError)) throw error;
        await reply.code(error.statusCode).send(accountErrorBody(error));
      }
    };
  const session = async (request: FastifyRequest) => {
    const verified = sessions.get(request);
    if (!verified) throw new AccountError(401);
    return verified;
  };
  return { admitBearer: admit(true), admitIp: admit(false), session, chargeAccount };
};

export type SyncRequestBudget = Awaited<ReturnType<typeof createSyncRequestBudget>>;
