import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { bearer } from 'better-auth/plugins/bearer';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { ultraBetterAuthAdapter } from './better-auth-adapter';
import { one, type SessionRow, type UltraDb } from './store';
import type { UltraConfig } from './security';

export const BETTER_AUTH_TOKEN_PREFIX = 'utba1_';
const message = z
  .string()
  .min(16)
  .max(4096)
  .regex(/^[A-Za-z0-9_+/=-]+$/);
export const opaqueLoginStartSchema = z
  .object({
    identifier: z.string().trim().toLowerCase().min(3).max(254),
    startLoginRequest: message,
    deviceName: z.string().trim().min(1).max(100).default('This device'),
  })
  .strict();
export const opaqueLoginFinishSchema = z
  .object({
    loginToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    finishLoginRequest: message,
  })
  .strict();
type LoginHandlers = {
  start: (
    input: z.infer<typeof opaqueLoginStartSchema>,
  ) => Promise<Record<string, unknown>>;
  finish: (
    input: z.infer<typeof opaqueLoginFinishSchema>,
  ) => Promise<Record<string, unknown>>;
};

const opaquePlugin = (handlers: LoginHandlers) =>
  ({
    id: 'ultra-opaque-v2',
    endpoints: {
      ultraOpaqueStart: createAuthEndpoint(
        '/ultra/opaque/start',
        {
          method: 'POST',
          body: opaqueLoginStartSchema,
        },
        async (ctx) => ctx.json(await handlers.start(ctx.body)),
      ),
      ultraOpaqueFinish: createAuthEndpoint(
        '/ultra/opaque/finish',
        {
          method: 'POST',
          body: opaqueLoginFinishSchema,
        },
        async (ctx) => ctx.json(await handlers.finish(ctx.body)),
      ),
    },
  }) satisfies BetterAuthPlugin;

/** No generic Better Auth HTTP handler is mounted: plaintext-password routes stay absent. */
export const createUltraBetterAuth = (
  db: UltraDb,
  config: UltraConfig,
  handlers?: LoginHandlers,
) =>
  betterAuth({
    appName: 'Ultra Tasks',
    baseURL: config.publicUrl,
    secret: config.authSecret,
    database: ultraBetterAuthAdapter(db),
    emailAndPassword: { enabled: false },
    telemetry: { enabled: false },
    logger: { disabled: true },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      disableCSRFCheck: false,
    },
    session: {
      expiresIn: 600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        nativeSessionId: { type: 'string', required: true, input: false },
      },
    },
    plugins: [bearer(), ...(handlers ? [opaquePlugin(handlers)] : [])],
  });

export const issueBetterAuthAccess = async (
  db: UltraDb,
  config: UltraConfig,
  session: Pick<SessionRow, 'id' | 'account_id'>,
): Promise<string> => {
  const auth = createUltraBetterAuth(db, config);
  const context = await auth.$context;
  // Called only inside the account-locked transaction after OPAQUE + enrolled MFA,
  // or an existing single-use refresh receipt. Never issued from a password proof alone.
  const result = await context.internalAdapter.createSession(session.account_id, false, {
    nativeSessionId: session.id,
  });
  if (!result) throw new Error('Better Auth could not create a session');
  return BETTER_AUTH_TOKEN_PREFIX + result.token;
};

export const authenticateBetterAuth = async (
  db: UltraDb,
  config: UltraConfig,
  accessToken: string,
): Promise<SessionRow | undefined> => {
  const auth = createUltraBetterAuth(db, config);
  const result = await auth.api.getSession({
    headers: new Headers({
      authorization: 'Bearer ' + accessToken.slice(BETTER_AUTH_TOKEN_PREFIX.length),
    }),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  const nativeId = result?.session.nativeSessionId;
  if (typeof nativeId !== 'string') return;
  return one<SessionRow>(
    db,
    Prisma.sql`SELECT * FROM ultra_sessions
    WHERE id=${nativeId} AND account_id=${result!.user.id} AND revoked=false
      AND expires_at>${BigInt(Date.now())} AND idle_expires_at>${BigInt(Date.now())}`,
  );
};
