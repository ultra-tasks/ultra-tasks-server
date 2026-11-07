import { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { z, ZodError } from 'zod';
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import {
  opaqueReady,
  opaqueServer,
  canonical,
  verify,
  AccountBundle,
  VaultContext,
} from '@ultra-tasks/account-crypto';
import {
  UltraBundleSchema,
  UltraUsernameSchema,
  ULTRA_OPAQUE_KSF,
} from '@ultra-tasks/sync-contract';
import {
  accountById,
  accountByIdentifier,
  factors,
  one,
  publicAccount,
  UltraDb,
  UltraTransaction,
  AccountRow,
  SessionRow,
  FactorRow,
} from './store';
import {
  AccountError,
  UltraConfig,
  authenticateAccount,
  challenge,
  readChallenge,
  digest,
  token,
  DAY,
  issueSession,
  issueTokens,
  requireRecent,
  newTotpSecret,
  encodePrivate,
  decodePrivate,
  totpStep,
  mfaCodes,
  verifyMfaCode,
} from './security';
import { ultraScopeRoutes } from './scope-routes';
import { UltraRealtimeHub, registerUltraRealtime } from './realtime';
import { deleteUltraAccount } from './account-deletion';
import { registerBrowserMfa } from './browser-mfa';
import { registerAccountOverview } from './overview-routes';

export interface UltraRoutesOptions {
  db: UltraDb;
  transaction: UltraTransaction;
  config: UltraConfig;
  requireTermsConsent?: boolean;
  hasOperatorTerms?: boolean;
  registrationOpen?: boolean;
  sendMail: (
    email: string,
    kind: 'verify' | 'recover',
    token: string,
  ) => Promise<boolean>;
  sendInviteMail?: (email: string) => Promise<boolean>;
  realtime?: UltraRealtimeHub;
}
const opaqueMessage = z
  .string()
  .min(16)
  .max(4096)
  .regex(/^[A-Za-z0-9_+/=-]+$/);
const challengeToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const identifier = z.string().trim().toLowerCase().min(3).max(254);
const device = z.string().trim().min(1).max(100).default('This device');
const credential = z.custom<RegistrationResponseJSON>(
  (value) => !!value && typeof value === 'object',
);
const authCredential = z.custom<AuthenticationResponseJSON>(
  (value) => !!value && typeof value === 'object',
);
const body = <T>(req: FastifyRequest, schema: z.ZodType<T>): T => schema.parse(req.body);
const factorData = (
  factor: FactorRow,
): { id: string; publicKey: string; counter: number } =>
  factor.data as unknown as { id: string; publicKey: string; counter: number };

export const ultraAccountRoutes = async (
  app: FastifyInstance,
  options: UltraRoutesOptions,
): Promise<void> => {
  const { db, transaction, config, sendMail } = options;
  const realtime = options.realtime ?? new UltraRealtimeHub(db, !!config.privateOnly);
  await registerUltraRealtime(app, { db, transaction, config, hub: realtime });
  await app.register(ultraScopeRoutes, { ...options, realtime, prefix: '/sync' });
  await registerAccountOverview(app, options);
  await opaqueReady;
  // Fail at startup if a corrupt setup was supplied, without logging the secret.
  try {
    opaqueServer.getPublicKey(config.opaqueSetup);
  } catch {
    throw new Error('Invalid ULTRA_OPAQUE_SETUP');
  }
  const auth = (req: FastifyRequest) =>
    authenticateAccount(db, config, req.headers.authorization);
  const requireLiveSession = async (tx: UltraDb, session: SessionRow) => {
    const live = await one(
      tx,
      Prisma.sql`SELECT id FROM ultra_sessions WHERE id=${session.id} AND account_id=${session.account_id} AND revoked=false AND expires_at>${BigInt(Date.now())} AND idle_expires_at>${BigInt(Date.now())} FOR UPDATE`,
    );
    if (!live) throw new AccountError(401);
  };
  const identity = (accountId: string): VaultContext => ({
    serverId: config.serverId,
    accountId,
  });
  const lockAccount = async (tx: UltraDb, id: string) => {
    const account = await one<AccountRow>(
      tx,
      Prisma.sql`SELECT * FROM ultra_accounts WHERE id=${id} FOR UPDATE`,
    );
    if (!account) throw new AccountError(401);
    return account;
  };
  const route = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    handler: (req: FastifyRequest) => Promise<unknown>,
    max = 30,
  ) => {
    app.route({
      method,
      url,
      bodyLimit: 131072,
      config: { rateLimit: { max, timeWindow: '15 minutes' } },
      handler: async (req, reply) => {
        reply
          .header('Cache-Control', 'no-store')
          .header('Referrer-Policy', 'no-referrer');
        try {
          const result = await handler(req);
          if (method !== 'GET') await realtime.refresh();
          return result;
        } catch (error) {
          if (error instanceof ZodError)
            return reply.code(400).send({ error: 'Invalid account request' });
          if (error instanceof AccountError)
            return reply.code(error.statusCode).send({ error: error.message });
          throw error;
        }
      },
    });
  };
  const post = (
    url: string,
    handler: (req: FastifyRequest) => Promise<unknown>,
    max?: number,
  ) => route('POST', url, handler, max);
  registerBrowserMfa({ db, transaction, config, post });
  const startRegistration = (accountId: string, registrationRequest: string) => {
    try {
      return opaqueServer.createRegistrationResponse({
        serverSetup: config.opaqueSetup,
        userIdentifier: canonical(identity(accountId)),
        registrationRequest,
      });
    } catch {
      throw new AccountError(400, 'Invalid password registration request');
    }
  };
  const newMail = async (
    account: AccountRow,
    kind: 'verify' | 'recover',
    data: object = {},
  ) => {
    const value = await challenge(
      db,
      config,
      kind,
      account.id,
      data,
      kind === 'verify' ? DAY : 3600000,
    );
    if (!(await sendMail(account.email, kind, value)))
      throw new AccountError(503, 'Email could not be delivered. Please try again.');
  };
  const loginResult = (accountId: string, deviceName: string) =>
    transaction(async (tx) => {
      const account = await lockAccount(tx, accountId);
      if (!account.verified)
        throw new AccountError(403, 'Verify your email before signing in');
      const enrolled = await factors(tx, accountId);
      if (enrolled.length)
        return {
          mfaToken: await challenge(tx, config, 'mfa', accountId, { deviceName }),
          factors: [...new Set(enrolled.map((factor) => factor.kind))],
        };
      return {
        ...(await issueSession(tx, config, accountId, deviceName)),
        account: publicAccount(account),
      };
    });

  route(
    'GET',
    '/capabilities',
    async () => ({
      protocol: 2,
      serverId: config.serverId,
      crypto: {
        vault: 1,
        record: 2,
        opaque: 'RFC9807',
        keyStretching: ULTRA_OPAQUE_KSF,
        hpke: 'P256-HKDF-SHA256-AES256GCM',
      },
      features: {
        passwordAccounts: true,
        recoveryKeys: true,
        totp: true,
        webauthn: true,
        scopedSync: true,
        sharedProjects: !config.privateOnly,
        sharedRealtime: !config.privateOnly,
        personalRealtime: !!config.privateOnly,
        registrationOpen: options.registrationOpen !== false,
        scopeRecovery: true,
        browserMfa: true,
      },
      requireTermsConsent: options.requireTermsConsent ?? false,
      hasOperatorTerms: options.hasOperatorTerms ?? false,
    }),
    300,
  );

  post('/register/start', async (req) => {
    if (options.registrationOpen === false)
      throw new AccountError(403, 'Account registration is closed on this server');
    const input = body(
      req,
      z
        .object({
          email: z.string().trim().toLowerCase().email().max(254),
          username: UltraUsernameSchema.optional(),
          displayName: z.string().trim().max(100).default(''),
          registrationRequest: opaqueMessage,
          termsAccepted: z.boolean().optional(),
        })
        .strict(),
    );
    if (options.requireTermsConsent && !input.termsAccepted)
      throw new AccountError(
        400,
        'Accept the linked privacy policy before creating an account',
      );
    const id = crypto.randomUUID();
    const registrationToken = await challenge(
      db,
      config,
      'register',
      id,
      {
        email: input.email,
        username: input.username ?? null,
        displayName: input.displayName,
        termsAccepted: input.termsAccepted === true,
      },
      1800000,
    );
    return {
      ...identity(id),
      registrationToken,
      ...startRegistration(id, input.registrationRequest),
      keyStretching: ULTRA_OPAQUE_KSF,
    };
  });
  post('/register/finish', async (req) => {
    if (options.registrationOpen === false)
      throw new AccountError(403, 'Account registration is closed on this server');
    const input = body(
      req,
      z
        .object({
          registrationToken: challengeToken,
          registrationRecord: opaqueMessage,
          bundle: UltraBundleSchema,
        })
        .strict(),
    );
    const pending = await readChallenge<{
      email: string;
      username: string | null;
      displayName: string;
      termsAccepted?: boolean;
    }>(db, config, input.registrationToken, 'register', true);
    if (options.requireTermsConsent && !pending.data.termsAccepted)
      throw new AccountError(
        400,
        'Accept the linked privacy policy before creating an account',
      );
    const id = pending.accountId!;
    // Validate public curve points as well as their JSON shape.
    for (const key of [input.bundle.encryptionPublicKey, input.bundle.signingPublicKey]) {
      try {
        await crypto.subtle.importKey(
          'jwk',
          { ...key, key_ops: [] },
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          [],
        );
      } catch {
        throw new AccountError(400, 'Invalid account public key');
      }
    }
    const account = await transaction(async (tx) => {
      // Replace only unverified enrollments. A stale verification link remains
      // bound to its old immutable id and cannot activate replacement keys.
      const replaced = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`DELETE FROM ultra_accounts WHERE email=${pending.data.email} AND verified=false RETURNING id`,
      );
      for (const old of replaced)
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM ultra_challenges WHERE account_id=${old.id}`,
        );
      const rows = await tx.$queryRaw<AccountRow[]>(
        Prisma.sql`INSERT INTO ultra_accounts(id,email,username,display_name,registration_record,bundle,terms_accepted_at,created_at) VALUES (${id},${pending.data.email},${pending.data.username},${pending.data.displayName},${input.registrationRecord},${JSON.stringify(input.bundle)}::jsonb,${pending.data.termsAccepted ? BigInt(Date.now()) : null},${BigInt(Date.now())}) ON CONFLICT DO NOTHING RETURNING *`,
      );
      return rows[0];
    });
    if (account) await newMail(account, 'verify');
    return {
      message: 'If registration is available, check your email to verify the account.',
    };
  });
  post('/verify-email', async (req) => {
    const { token: value } = body(req, z.object({ token: challengeToken }).strict());
    await transaction(async (tx) => {
      const pending = await readChallenge<{
        email?: string;
        oldEmail?: string;
        version?: number;
      }>(tx, config, value, 'verify', true);
      const account = await lockAccount(tx, pending.accountId!);
      if (
        pending.data.email &&
        (pending.data.version !== account.vault_version ||
          pending.data.oldEmail !== account.email)
      )
        throw new AccountError(401);
      if (pending.data.email)
        await tx.$executeRaw(
          Prisma.sql`UPDATE ultra_accounts SET email=${pending.data.email},verified=true WHERE id=${pending.accountId}`,
        );
      else
        await tx.$executeRaw(
          Prisma.sql`UPDATE ultra_accounts SET verified=true WHERE id=${pending.accountId}`,
        );
    });
    return { verified: true };
  });
  post(
    '/verification/resend',
    async (req) => {
      const { identifier: name } = body(req, z.object({ identifier }).strict());
      const account = await accountByIdentifier(db, name);
      if (account && !account.verified) await newMail(account, 'verify');
      return { message: 'If verification is needed, check your email.' };
    },
    5,
  );

  post('/login/start', async (req) => {
    const input = body(
      req,
      z
        .object({ identifier, startLoginRequest: opaqueMessage, deviceName: device })
        .strict(),
    );
    const account = await accountByIdentifier(db, input.identifier);
    const fake = createHmac('sha256', config.authSecret)
      .update(input.identifier)
      .digest('hex');
    const id =
      account?.id ??
      `${fake.slice(0, 8)}-${fake.slice(8, 12)}-4${fake.slice(13, 16)}-a${fake.slice(17, 20)}-${fake.slice(20, 32)}`;
    let result: ReturnType<typeof opaqueServer.startLogin>;
    try {
      result = opaqueServer.startLogin({
        serverSetup: config.opaqueSetup,
        registrationRecord: account?.registration_record,
        userIdentifier: canonical(identity(id)),
        startLoginRequest: input.startLoginRequest,
      });
    } catch {
      throw new AccountError(401);
    }
    const loginToken = await challenge(db, config, 'login', account?.id ?? null, {
      state: result.serverLoginState,
      deviceName: input.deviceName,
    });
    return {
      ...identity(id),
      loginToken,
      loginResponse: result.loginResponse,
      keyStretching: ULTRA_OPAQUE_KSF,
    };
  });
  post('/login/finish', async (req) => {
    const input = body(
      req,
      z
        .object({ loginToken: challengeToken, finishLoginRequest: opaqueMessage })
        .strict(),
    );
    const pending = await readChallenge<{ state: string; deviceName: string }>(
      db,
      config,
      input.loginToken,
      'login',
      true,
    );
    try {
      opaqueServer.finishLogin({
        serverLoginState: pending.data.state,
        finishLoginRequest: input.finishLoginRequest,
      });
    } catch {
      throw new AccountError(401);
    }
    if (!pending.accountId) throw new AccountError(401);
    return loginResult(pending.accountId, pending.data.deviceName);
  });
  post('/mfa/complete', async (req) => {
    const input = body(
      req,
      z.object({ mfaToken: challengeToken, code: z.string().min(6).max(64) }).strict(),
    );
    const pending = await readChallenge<{ deviceName: string }>(
      db,
      config,
      input.mfaToken,
      'mfa',
    );
    return transaction(async (tx) => {
      const account = await lockAccount(tx, pending.accountId!);
      if (!(await verifyMfaCode(tx, config, account.id, input.code)))
        throw new AccountError(401);
      await readChallenge(tx, config, input.mfaToken, 'mfa', true);
      return {
        ...(await issueSession(tx, config, account.id, pending.data.deviceName)),
        account: publicAccount(account),
      };
    });
  });
  post('/mfa/webauthn/options', async (req) => {
    const { mfaToken } = body(req, z.object({ mfaToken: challengeToken }).strict());
    const pending = await readChallenge(db, config, mfaToken, 'mfa');
    const enrolled = (await factors(db, pending.accountId!)).filter(
      (factor) => factor.kind === 'webauthn',
    );
    if (!enrolled.length) throw new AccountError(401);
    const authentication = await generateAuthenticationOptions({
      rpID: config.rpId,
      allowCredentials: enrolled.map((factor) => ({ id: factorData(factor).id })),
      userVerification: 'required',
    });
    return {
      options: authentication,
      credentialToken: await challenge(db, config, 'webauthn-login', pending.accountId, {
        mfaToken,
        challenge: authentication.challenge,
      }),
    };
  });
  post('/mfa/webauthn/complete', async (req) => {
    const input = body(
      req,
      z.object({ credentialToken: challengeToken, credential: authCredential }).strict(),
    );
    const pending = await readChallenge<{ mfaToken: string; challenge: string }>(
      db,
      config,
      input.credentialToken,
      'webauthn-login',
      true,
    );
    const factor = (await factors(db, pending.accountId!)).find(
      (row) => row.kind === 'webauthn' && factorData(row).id === input.credential.id,
    );
    if (!factor) throw new AccountError(401);
    const data = factorData(factor);
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: input.credential,
        expectedChallenge: pending.data.challenge,
        expectedOrigin: config.publicUrl,
        expectedRPID: config.rpId,
        requireUserVerification: true,
        credential: {
          id: data.id,
          publicKey: new Uint8Array(Buffer.from(data.publicKey, 'base64url')),
          counter: data.counter,
        },
      });
    } catch {
      throw new AccountError(401);
    }
    if (!result.verified) throw new AccountError(401);
    return transaction(async (tx) => {
      const account = await lockAccount(tx, pending.accountId!);
      const login = await readChallenge<{ deviceName: string }>(
        tx,
        config,
        pending.data.mfaToken,
        'mfa',
        true,
      );
      const count = await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_factors SET data=${JSON.stringify({ ...data, counter: result.authenticationInfo.newCounter })}::jsonb WHERE id=${factor.id} AND enabled=true AND data=${JSON.stringify(factor.data)}::jsonb`,
      );
      if (!count) throw new AccountError(401);
      return {
        ...(await issueSession(tx, config, account.id, login.data.deviceName)),
        account: publicAccount(account),
      };
    });
  });

  post(
    '/sessions/refresh',
    async (req) => {
      const { refreshToken } = body(
        req,
        z.object({ refreshToken: challengeToken }).strict(),
      );
      const result = await transaction(async (tx) => {
        const row = await one<SessionRow & { used: boolean }>(
          tx,
          Prisma.sql`SELECT s.*,t.used FROM ultra_refresh_tokens t JOIN ultra_sessions s ON t.session_id=s.id WHERE t.digest=${digest(refreshToken)} FOR UPDATE OF s,t`,
        );
        if (
          !row ||
          row.revoked ||
          Number(row.expires_at) <= Date.now() ||
          Number(row.idle_expires_at) <= Date.now()
        )
          return null;
        if (row.used) {
          await tx.$executeRaw(
            Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE id=${row.id}`,
          );
          return null;
        }
        await tx.$executeRaw(
          Prisma.sql`UPDATE ultra_refresh_tokens SET used=true WHERE digest=${digest(refreshToken)}`,
        );
        await tx.$executeRaw(
          Prisma.sql`UPDATE ultra_sessions SET idle_expires_at=${BigInt(Math.min(Number(row.expires_at), Date.now() + 30 * DAY))} WHERE id=${row.id}`,
        );
        return issueTokens(tx, config, row);
      });
      if (!result) throw new AccountError(401);
      return result;
    },
    300,
  );
  route(
    'GET',
    '/me',
    async (req) => {
      const session = await auth(req);
      const account = await accountById(db, session.account_id);
      return {
        account: publicAccount(account!),
        bundle: account!.bundle,
        factors: (await factors(db, session.account_id)).map((factor) => ({
          id: factor.id,
          kind: factor.kind,
        })),
      };
    },
    300,
  );
  route(
    'GET',
    '/sessions',
    async (req) => {
      const session = await auth(req);
      const rows = await db.$queryRaw<
        { id: string; device_name: string; created_at: bigint; revoked: boolean }[]
      >(
        Prisma.sql`SELECT id,device_name,created_at,revoked FROM ultra_sessions WHERE account_id=${session.account_id} ORDER BY created_at DESC`,
      );
      return rows.map((row) => ({
        id: row.id,
        deviceName: row.device_name,
        createdAt: Number(row.created_at),
        revoked: row.revoked,
        current: row.id === session.id,
      }));
    },
    300,
  );
  post('/sessions/revoke', async (req) => {
    const session = await auth(req);
    const { sessionId } = body(req, z.object({ sessionId: z.string().uuid() }).strict());
    await db.$executeRaw(
      Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE id=${sessionId} AND account_id=${session.account_id}`,
    );
    return { revoked: true };
  });
  post('/delete', async (req) => {
    const session = await auth(req);
    const input = body(
      req,
      z
        .object({
          vaultVersion: z.number().int().positive(),
          signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
        })
        .strict(),
    );
    return transaction(async (tx) => {
      await requireLiveSession(tx, session);
      const account = await lockAccount(tx, session.account_id);
      return deleteUltraAccount(tx, config, session, account, input);
    });
  });

  post('/factors/totp/start', async (req) => {
    const session = await auth(req);
    requireRecent(session);
    const secret = newTotpSecret();
    const account = await accountById(db, session.account_id);
    return {
      secret,
      uri: `otpauth://totp/Ultra%20Tasks:${encodeURIComponent(account!.email)}?secret=${secret}&issuer=Ultra%20Tasks&algorithm=SHA1&digits=6&period=30`,
      enrollmentToken: await challenge(db, config, 'totp-enroll', session.account_id, {
        secret,
        sessionId: session.id,
      }),
    };
  });
  post('/factors/totp/finish', async (req) => {
    const session = await auth(req);
    requireRecent(session);
    const input = body(
      req,
      z
        .object({ enrollmentToken: challengeToken, code: z.string().regex(/^\d{6}$/) })
        .strict(),
    );
    const pending = await readChallenge<{ secret: string; sessionId: string }>(
      db,
      config,
      input.enrollmentToken,
      'totp-enroll',
    );
    const step = totpStep(pending.data.secret, input.code);
    if (
      pending.accountId !== session.account_id ||
      pending.data.sessionId !== session.id ||
      step === undefined
    )
      throw new AccountError(401);
    return transaction(async (tx) => {
      await lockAccount(tx, session.account_id);
      await requireLiveSession(tx, session);
      await readChallenge(tx, config, input.enrollmentToken, 'totp-enroll', true);
      const id = crypto.randomUUID();
      const encrypted = await encodePrivate(config, id, pending.data.secret);
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_factors WHERE account_id=${session.account_id} AND kind='totp'`,
      );
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_factors(id,account_id,kind,enabled,data,last_step) VALUES (${id},${session.account_id},'totp',true,${JSON.stringify({ encrypted })}::jsonb,${BigInt(step)})`,
      );
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE account_id=${session.account_id} AND id<>${session.id}`,
      );
      return { recoveryCodes: await mfaCodes(tx, session.account_id) };
    });
  });
  post('/factors/webauthn/start', async (req) => {
    const session = await auth(req);
    requireRecent(session);
    const account = await accountById(db, session.account_id);
    const registration = await generateRegistrationOptions({
      rpName: 'Ultra Tasks',
      rpID: config.rpId,
      userName: account!.email,
      userID: new TextEncoder().encode(account!.id),
      attestationType: 'none',
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      excludeCredentials: (await factors(db, session.account_id))
        .filter((row) => row.kind === 'webauthn')
        .map((row) => ({ id: factorData(row).id })),
    });
    return {
      options: registration,
      enrollmentToken: await challenge(
        db,
        config,
        'webauthn-enroll',
        session.account_id,
        { challenge: registration.challenge, sessionId: session.id },
      ),
    };
  });
  post('/factors/webauthn/finish', async (req) => {
    const session = await auth(req);
    requireRecent(session);
    const input = body(
      req,
      z.object({ enrollmentToken: challengeToken, credential }).strict(),
    );
    const pending = await readChallenge<{ challenge: string; sessionId: string }>(
      db,
      config,
      input.enrollmentToken,
      'webauthn-enroll',
      true,
    );
    if (pending.accountId !== session.account_id || pending.data.sessionId !== session.id)
      throw new AccountError(401);
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: input.credential,
        expectedChallenge: pending.data.challenge,
        expectedOrigin: config.publicUrl,
        expectedRPID: config.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new AccountError(401);
    }
    if (!result.verified || !result.registrationInfo) throw new AccountError(401);
    const key = result.registrationInfo.credential;
    return transaction(async (tx) => {
      await lockAccount(tx, session.account_id);
      await requireLiveSession(tx, session);
      const enrolled = await factors(tx, session.account_id);
      if (enrolled.length >= 10)
        throw new AccountError(409, 'Remove an old second factor first');
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_factors(id,account_id,kind,enabled,data) VALUES (${crypto.randomUUID()},${session.account_id},'webauthn',true,${JSON.stringify({ id: key.id, publicKey: Buffer.from(key.publicKey).toString('base64url'), counter: key.counter })}::jsonb)`,
      );
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE account_id=${session.account_id} AND id<>${session.id}`,
      );
      return { recoveryCodes: await mfaCodes(tx, session.account_id) };
    });
  });
  post('/factors/remove', async (req) => {
    const session = await auth(req);
    requireRecent(session);
    const { factorId, code } = body(
      req,
      z.object({ factorId: z.string().uuid(), code: z.string().min(6).max(64) }).strict(),
    );
    await transaction(async (tx) => {
      await lockAccount(tx, session.account_id);
      await requireLiveSession(tx, session);
      if (!(await verifyMfaCode(tx, config, session.account_id, code)))
        throw new AccountError(401);
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_factors WHERE id=${factorId} AND account_id=${session.account_id}`,
      );
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE account_id=${session.account_id} AND id<>${session.id}`,
      );
    });
    return { removed: true };
  });

  post('/password/start', async (req) => {
    const session = await auth(req);
    requireRecent(session);
    const { registrationRequest } = body(
      req,
      z.object({ registrationRequest: opaqueMessage }).strict(),
    );
    const account = await accountById(db, session.account_id);
    return {
      ...identity(account!.id),
      ...startRegistration(account!.id, registrationRequest),
      changeToken: await challenge(db, config, 'password', account!.id, {
        version: account!.vault_version,
        sessionId: session.id,
      }),
      keyStretching: ULTRA_OPAQUE_KSF,
    };
  });
  const updatePassword = async (
    tx: UltraDb,
    account: AccountRow,
    registrationRecord: string,
    bundle: AccountBundle,
  ) => {
    if (
      canonical(bundle.encryptionPublicKey) !==
        canonical(account.bundle.encryptionPublicKey) ||
      canonical(bundle.signingPublicKey) !== canonical(account.bundle.signingPublicKey) ||
      canonical(bundle.vault) !== canonical(account.bundle.vault) ||
      canonical(bundle.recoveryWrap) !== canonical(account.bundle.recoveryWrap)
    )
      throw new AccountError(
        400,
        'Password changes must preserve content and recovery keys',
      );
    await tx.$executeRaw(
      Prisma.sql`UPDATE ultra_accounts SET registration_record=${registrationRecord},bundle=${JSON.stringify(bundle)}::jsonb,vault_version=vault_version+1 WHERE id=${account.id}`,
    );
    await tx.$executeRaw(
      Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE account_id=${account.id}`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM ultra_challenges WHERE account_id=${account.id} AND kind IN ('login','mfa','mfa-browser','webauthn-login','password','recover','recover-bootstrap')`,
    );
  };
  post('/password/finish', async (req) => {
    const session = await auth(req);
    requireRecent(session);
    const input = body(
      req,
      z
        .object({
          changeToken: challengeToken,
          registrationRecord: opaqueMessage,
          bundle: UltraBundleSchema,
          signature: z.string().max(128),
        })
        .strict(),
    );
    const pending = await readChallenge<{ version: number; sessionId: string }>(
      db,
      config,
      input.changeToken,
      'password',
    );
    if (pending.accountId !== session.account_id || pending.data.sessionId !== session.id)
      throw new AccountError(401);
    return transaction(async (tx) => {
      const account = await lockAccount(tx, session.account_id);
      await requireLiveSession(tx, session);
      if (
        account.vault_version !== pending.data.version ||
        !(await verify(
          account.bundle.signingPublicKey,
          {
            action: 'password',
            token: input.changeToken,
            registrationRecord: input.registrationRecord,
            bundle: input.bundle,
          },
          input.signature,
        ))
      )
        throw new AccountError(409, 'Vault changed or signature invalid. Sign in again.');
      await readChallenge(tx, config, input.changeToken, 'password', true);
      await updatePassword(tx, account, input.registrationRecord, input.bundle);
      return issueSession(tx, config, account.id, session.device_name);
    });
  });
  post(
    '/recovery/request',
    async (req) => {
      const { identifier: name } = body(req, z.object({ identifier }).strict());
      const account = await accountByIdentifier(db, name);
      if (account?.verified) await newMail(account, 'recover');
      return {
        message:
          'If the account exists, check your email for the recovery link. Your recovery key is also required.',
      };
    },
    5,
  );
  post('/recovery/start', async (req) => {
    const input = body(
      req,
      z.object({ token: challengeToken, registrationRequest: opaqueMessage }).strict(),
    );
    const pending = await readChallenge(db, config, input.token, 'recover');
    const account = await accountById(db, pending.accountId!);
    if (!account) throw new AccountError(401);
    return {
      ...identity(account.id),
      bundle: account.bundle,
      ...startRegistration(account.id, input.registrationRequest),
      recoveryToken: await challenge(db, config, 'recover-bootstrap', account.id, {
        mailToken: input.token,
        version: account.vault_version,
      }),
      mfaRequired: (await factors(db, account.id)).length > 0,
      keyStretching: ULTRA_OPAQUE_KSF,
    };
  });
  post('/recovery/finish', async (req) => {
    const input = body(
      req,
      z
        .object({
          recoveryToken: challengeToken,
          registrationRecord: opaqueMessage,
          bundle: UltraBundleSchema,
          signature: z.string().max(128),
          code: z.string().max(64).optional(),
        })
        .strict(),
    );
    const pending = await readChallenge<{ mailToken: string; version: number }>(
      db,
      config,
      input.recoveryToken,
      'recover-bootstrap',
    );
    await transaction(async (tx) => {
      const account = await lockAccount(tx, pending.accountId!);
      if (
        account.vault_version !== pending.data.version ||
        !(await verify(
          account.bundle.signingPublicKey,
          {
            action: 'recover',
            token: input.recoveryToken,
            registrationRecord: input.registrationRecord,
            bundle: input.bundle,
          },
          input.signature,
        ))
      )
        throw new AccountError(401);
      if (
        (await factors(tx, account.id)).length &&
        !(await verifyMfaCode(tx, config, account.id, input.code ?? ''))
      )
        throw new AccountError(401, 'Enter an authenticator code or MFA recovery code');
      await readChallenge(tx, config, pending.data.mailToken, 'recover', true);
      await readChallenge(tx, config, input.recoveryToken, 'recover-bootstrap', true);
      await updatePassword(tx, account, input.registrationRecord, input.bundle);
    });
    return {
      recovered: true,
      message: 'Password changed. Sign in with the new password.',
    };
  });
  route('PUT', '/profile', async (req) => {
    const session = await auth(req);
    requireRecent(session);
    const input = body(
      req,
      z
        .object({
          username: UltraUsernameSchema.nullable(),
          displayName: z.string().trim().max(100),
          email: z.string().trim().toLowerCase().email().max(254).optional(),
        })
        .strict(),
    );
    const account = await transaction(async (tx) => {
      const current = await lockAccount(tx, session.account_id);
      await requireLiveSession(tx, session);
      try {
        await tx.$executeRaw(
          Prisma.sql`UPDATE ultra_accounts SET username=${input.username},display_name=${input.displayName} WHERE id=${session.account_id}`,
        );
      } catch {
        throw new AccountError(409, 'Username unavailable');
      }
      return current;
    });
    if (input.email && input.email !== account!.email) {
      const value = await challenge(
        db,
        config,
        'verify',
        account!.id,
        { email: input.email, oldEmail: account!.email, version: account!.vault_version },
        DAY,
      );
      if (!(await sendMail(input.email, 'verify', value)))
        throw new AccountError(503, 'Email could not be delivered');
    }
    return { updated: true };
  });
};
