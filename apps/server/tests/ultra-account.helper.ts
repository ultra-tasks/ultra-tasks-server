import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import {
  AccountClient,
  Transport,
  opaqueClient,
  opaqueReady,
  opaqueServer,
  AccountApiError,
} from '@ultra-tasks/account-crypto';
import { registerPublicCalendarFeeds } from '../src/ultra-account/calendar-feeds';
import { ultraAccountRoutes } from '../src/ultra-account/routes';
import { UltraConfig } from '../src/ultra-account/security';
import { UltraDb, UltraTransaction } from '../src/ultra-account/store';
import { UltraRealtimeHub } from '../src/ultra-account/realtime';

export const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../prisma/migrations/20261105000000_ultra_accounts/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);
export const password = 'test password for encrypted accounts';
export const createHarness = async (
  settings: {
    requireTermsConsent?: boolean;
    hasOperatorTerms?: boolean;
    registrationOpen?: boolean;
    privateOnly?: boolean;
    authEngine?: 'native' | 'better-auth';
    /**
     * New-device email verification. Off by default here so every suite written before the feature
     * keeps its behavior; a test that exercises it opts in with `deviceEmailVerification: true`.
     */
    deviceEmailVerification?: boolean;
    disableRateLimit?: boolean;
    turnstile?: { siteKey: string; secret: string; hostname: string };
  } = {},
) => {
  const { disableRateLimit, ...accountSettings } = settings;
  await opaqueReady;
  const database = new PGlite();
  await database.waitReady;
  await database.exec(migration);
  await database.exec(
    readFileSync(
      new URL(
        '../prisma/migrations/20261115000000_calendar_feeds/migration.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  await database.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          '../prisma/migrations/20261109000000_ultra_registration_expiry/migration.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );
  await database.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          '../prisma/migrations/20261105010000_ultra_scopes/migration.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );
  await database.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          '../prisma/migrations/20261105020000_ultra_recovery_realtime/migration.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );
  await database.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          '../prisma/migrations/20261107000000_better_auth_prototype/migration.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );
  await database.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          '../prisma/migrations/20261108000000_personal_replacements/migration.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );
  await database.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          '../prisma/migrations/20261111000000_ultra_record_heads_mutation_index/migration.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );
  await database.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          '../prisma/migrations/20261118000000_account_devices_sessions/migration.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );
  const rawDb = {
    $queryRaw: async (sql: Prisma.Sql) =>
      (await database.query(sql.text, sql.values)).rows,
    $executeRaw: async (sql: Prisma.Sql) =>
      (await database.query(sql.text, sql.values)).affectedRows ?? 0,
  } as UltraDb;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };
  const db = {
    $queryRaw: (sql: Prisma.Sql) => enqueue(() => rawDb.$queryRaw(sql)),
    $executeRaw: (sql: Prisma.Sql) => enqueue(() => rawDb.$executeRaw(sql)),
  } as UltraDb;

  const transaction: UltraTransaction = (run) => {
    const result = queue.then(async () => {
      await database.exec('BEGIN');
      try {
        const value = await run(rawDb);
        await database.exec('COMMIT');
        return value;
      } catch (error) {
        await database.exec('ROLLBACK');
        throw error;
      }
    });
    queue = result.catch(() => undefined);
    return result;
  };
  const config: UltraConfig = {
    serverId: crypto.randomUUID(),
    opaqueSetup: opaqueServer.createSetup(),
    authSecret: 'an isolated test operator secret at least 32 bytes',
    publicUrl: 'http://localhost:1900',
    rpId: 'localhost',
    privateOnly: settings.privateOnly,
    authEngine:
      settings.authEngine ??
      (process.env.ULTRA_TEST_AUTH_ENGINE === 'better-auth' ? 'better-auth' : undefined),
  };
  type MailKind = 'verify' | 'recover' | 'device';
  /** Delivered mail; for kind `device` the token is the eight-digit sign-in code. */
  const mail: { email: string; kind: MailKind; token: string }[] = [];
  /** A kind in this set is refused by the mail provider (nothing is recorded or delivered). */
  const failingMail = new Set<MailKind>();
  const app = Fastify();
  const realtime = new UltraRealtimeHub(db, !!settings.privateOnly);
  await app.register(websocket, { options: { maxPayload: 1024 } });
  // Only the synthetic multi-browser migration harness opts out: its many
  // independent accounts all connect from the same loopback IP.
  await app.register(rateLimit, {
    global: false,
    ...(disableRateLimit ? { allowList: () => true } : {}),
  });
  await registerPublicCalendarFeeds(app, db);
  await app.register(ultraAccountRoutes, {
    prefix: '/api/v2/accounts',
    realtime,
    db,
    transaction,
    config,
    deviceEmailVerification: false,
    ...accountSettings,
    sendMail: async (email, kind, token) => {
      if (failingMail.has(kind)) return false;
      mail.push({ email, kind, token });
      return true;
    },
  });
  const requests: string[] = [];
  const transport: Transport = async (
    path,
    body,
    accessToken,
    method = body ? 'POST' : 'GET',
  ) => {
    if (body) requests.push(JSON.stringify(body));
    const result = await app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: '/api/v2/accounts' + path,
      payload: body,
      headers: accessToken ? { authorization: 'Bearer ' + accessToken } : {},
    });
    if (result.statusCode >= 400) {
      const failure = result.json() as { error?: string; code?: string };
      throw new AccountApiError(
        result.statusCode,
        failure.error ?? String(result.statusCode),
        failure.code,
      );
    }
    return result.json();
  };
  const client = () => new AccountClient(transport);
  /**
   * The exact sign-in requests of SDK 0.1.4 and earlier: `/login/start` with a device name and a
   * `/login/finish` that carries neither `clientFeatures` nor a device token. `extra` is merged
   * into the finish body for tests that probe strictness. Returns the raw response body.
   */
  const legacyLogin = async (
    identifier: string,
    pw = password,
    extra: Record<string, unknown> = {},
  ) => {
    const started = opaqueClient.startLogin({ password: pw });
    const response = (await transport('/login/start', {
      identifier,
      startLoginRequest: started.startLoginRequest,
      deviceName: 'Old client',
    })) as { loginToken: string; loginResponse: string };
    const proof = opaqueClient.finishLogin({
      ...started,
      password: pw,
      loginResponse: response.loginResponse,
      keyStretching: 'memory-constrained',
    });
    if (!proof) throw new Error('Wrong password for the legacy sign-in helper');
    return transport('/login/finish', {
      loginToken: response.loginToken,
      finishLoginRequest: proof.finishLoginRequest,
      ...extra,
    }) as Promise<Record<string, unknown>>;
  };
  const register = async (email = 'alice@example.test', username = 'alice') => {
    const account = client();
    const prepared = await account.prepareRegistration(
      { email, username, displayName: username },
      password,
    );
    await account.register(prepared);
    const verifyToken = mail.findLast(
      (message) => message.email === email && message.kind === 'verify',
    )!.token;
    await transport('/verify-email', { identifier: email, code: verifyToken });
    const signedIn = await account.login(email, password);
    // With new-device verification on, a new account's first sign-in is an unrecognised device.
    if (signedIn.verification)
      await account.completeDeviceVerification(
        mail.findLast((message) => message.email === email && message.kind === 'device')!
          .token,
      );
    return { client: account, prepared, verifyToken };
  };
  return {
    app,
    realtime,
    db,
    database,
    config,
    mail,
    failingMail,
    transport,
    requests,
    client,
    legacyLogin,
    register,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
};
