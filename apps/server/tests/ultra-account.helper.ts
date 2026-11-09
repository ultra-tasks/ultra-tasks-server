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
  opaqueReady,
  opaqueServer,
  AccountApiError,
} from '@ultra-tasks/account-crypto';
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
  } = {},
) => {
  await opaqueReady;
  const database = new PGlite();
  await database.waitReady;
  await database.exec(migration);
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
  const mail: { email: string; kind: 'verify' | 'recover'; token: string }[] = [];
  const app = Fastify();
  const realtime = new UltraRealtimeHub(db, !!settings.privateOnly);
  await app.register(websocket, { options: { maxPayload: 1024 } });
  await app.register(rateLimit, { global: false });
  await app.register(ultraAccountRoutes, {
    prefix: '/api/v2/accounts',
    realtime,
    db,
    transaction,
    config,
    ...settings,
    sendMail: async (email, kind, token) => {
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
    if (result.statusCode >= 400)
      throw new AccountApiError(
        result.statusCode,
        result.json().error ?? String(result.statusCode),
      );
    return result.json();
  };
  const client = () => new AccountClient(transport);
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
    await transport('/verify-email', { token: verifyToken });
    await account.login(email, password);
    return { client: account, prepared, verifyToken };
  };
  return {
    app,
    realtime,
    db,
    database,
    config,
    mail,
    transport,
    requests,
    client,
    register,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
};
