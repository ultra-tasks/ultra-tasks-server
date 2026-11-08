/**
 * Real PostgreSQL lock coverage for the Better Auth refresh bridge.
 * Requires ULTRA_AUTH_TEST_DATABASE_URL and CREATE SCHEMA permission. All writes
 * stay in a unique test schema; DATABASE_URL is never read or used as a fallback.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerBrowserLogin } from '../src/ultra-account/browser-login';
import {
  canonical,
  createAccountBundle,
  opaqueClient,
  opaqueReady,
  opaqueServer,
  type AccountBundle,
  AccountClient,
  approveBrowserLogin,
  newBrowserLogin,
  type Transport,
  type Tokens,
  type VaultSecrets,
} from '@ultra-tasks/account-crypto';
import {
  authenticateAccount,
  AccountError,
  digest,
  issueSession,
  issueTokens,
  type UltraConfig,
} from '../src/ultra-account/security';
import type { SessionRow } from '../src/ultra-account/store';

const barrier = () => {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
};

describe('Better Auth refresh locking (PostgreSQL)', () => {
  const schema = 'better_auth_refresh_' + randomUUID().replaceAll('-', '');
  const accountId = randomUUID();
  const config: UltraConfig = {
    serverId: randomUUID(),
    opaqueSetup: '',
    authSecret: 'isolated PostgreSQL authentication test secret only',
    publicUrl: 'http://localhost:1900',
    rpId: 'localhost',
    authEngine: 'better-auth',
  };
  let admin: PrismaClient | undefined;
  let refreshDb: PrismaClient;
  let securityDb: PrismaClient;
  let schemaCreated = false;
  let registrationRecord: string;
  let bundle: AccountBundle;
  let masterKey: string;
  let secrets: VaultSecrets;
  let session: SessionRow;
  let refreshToken: string;

  beforeAll(async () => {
    const testDatabaseUrl = process.env.ULTRA_AUTH_TEST_DATABASE_URL;
    if (!testDatabaseUrl)
      throw new Error('ULTRA_AUTH_TEST_DATABASE_URL is required for this suite');
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set('schema', schema);
    isolatedUrl.searchParams.set('connection_limit', '1');
    admin = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    // The interpolated identifier contains only our fixed prefix and UUID hex.
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    refreshDb = new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });
    securityDb = new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });
    for (const migration of [
      '20261105000000_ultra_accounts',
      '20261107000000_better_auth_prototype',
    ]) {
      const sql = readFileSync(
        new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url),
        'utf8',
      );
      // These migrations contain plain DDL, with no procedural statement bodies.
      for (const statement of sql
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean))
        await refreshDb.$executeRawUnsafe(statement);
    }

    await opaqueReady;
    config.opaqueSetup = opaqueServer.createSetup();
    const identity = { serverId: config.serverId, accountId };
    const password = 'synthetic PostgreSQL account password';
    const started = opaqueClient.startRegistration({ password });
    const response = opaqueServer.createRegistrationResponse({
      serverSetup: config.opaqueSetup,
      userIdentifier: canonical(identity),
      registrationRequest: started.registrationRequest,
    });
    registrationRecord = opaqueClient.finishRegistration({
      ...started,
      registrationResponse: response.registrationResponse,
      password,
      keyStretching: 'memory-constrained',
    }).registrationRecord;
    ({ bundle, masterKey, secrets } = await createAccountBundle(password, identity));
  });

  beforeEach(async () => {
    await refreshDb.$executeRaw(Prisma.sql`INSERT INTO ultra_accounts
      (id,email,username,display_name,verified,registration_record,bundle,created_at)
      VALUES (${accountId},'review@example.test','review','Synthetic review',true,
        ${registrationRecord},${JSON.stringify(bundle)}::jsonb,${BigInt(Date.now())})`);
    const tokens = await refreshDb.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ultra_accounts
        WHERE id=${accountId} FOR UPDATE`);
      return issueSession(tx, config, accountId, 'PostgreSQL race fixture');
    });
    refreshToken = tokens.refreshToken;
    [session] = await refreshDb.$queryRaw<SessionRow[]>(Prisma.sql`SELECT s.*
      FROM ultra_sessions s JOIN ultra_refresh_tokens t ON t.session_id=s.id
      WHERE t.digest=${digest(refreshToken)}`);
  });

  afterEach(async () => {
    if (!schemaCreated) return;
    await refreshDb.$executeRawUnsafe(`ALTER TABLE ultra_better_auth_sessions
      DROP CONSTRAINT IF EXISTS better_auth_review_account_fk`);
    await refreshDb.$executeRaw(
      Prisma.sql`DELETE FROM ultra_accounts WHERE id=${accountId}`,
    );
  });

  afterAll(async () => {
    try {
      await Promise.all([refreshDb?.$disconnect(), securityDb?.$disconnect()]);
    } finally {
      try {
        if (schemaCreated)
          await admin!.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin?.$disconnect();
      }
    }
  });

  const raceRefreshWithSecurityChange = async () => {
    const sessionLocked = barrier();
    const accountLocked = barrier();
    const refresh = refreshDb
      .$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<(SessionRow & { used: boolean })[]>(
            Prisma.sql`SELECT s.*,t.used FROM ultra_refresh_tokens t
          JOIN ultra_sessions s ON t.session_id=s.id
          WHERE t.digest=${digest(refreshToken)} FOR UPDATE OF s,t`,
          );
          expect(row.used).toBe(false);
          sessionLocked.release();
          await accountLocked.reached;
          await tx.$executeRaw(Prisma.sql`UPDATE ultra_refresh_tokens SET used=true
        WHERE digest=${digest(refreshToken)}`);
          // Runs the real issueBetterAuthAccess and SQL adapter inside this transaction.
          return issueTokens(tx, config, row);
        },
        { maxWait: 10000, timeout: 20000 },
      )
      .finally(sessionLocked.release);
    const securityChange = securityDb
      .$transaction(
        async (tx) => {
          await sessionLocked.reached;
          await tx.$queryRaw(Prisma.sql`SELECT id FROM ultra_accounts
        WHERE id=${accountId} FOR UPDATE`);
          accountLocked.release();
          await tx.$queryRaw(Prisma.sql`SELECT id FROM ultra_sessions
        WHERE id=${session.id} AND account_id=${accountId} FOR UPDATE`);
          await tx.$executeRaw(Prisma.sql`UPDATE ultra_sessions SET revoked=true
        WHERE account_id=${accountId}`);
        },
        { maxWait: 10000, timeout: 20000 },
      )
      .finally(accountLocked.release);
    // Attach both rejection handlers immediately; the negative control must reject.
    return Promise.allSettled([refresh, securityChange]);
  };

  it.each(['native', 'better-auth'] as const)(
    'redeems a browser grant once across real PostgreSQL connections (%s)',
    async (authEngine) => {
      config.authEngine = authEngine;
      const apps = [refreshDb, securityDb].map((db) => {
        const app = Fastify();
        registerBrowserLogin({
          db,
          config,
          transaction: (run) => db.$transaction(run, { maxWait: 10000, timeout: 20000 }),
          post: (url, handler) => {
            app.post(url, async (req, reply) => {
              try {
                return await handler(req);
              } catch (error) {
                if (error instanceof AccountError)
                  return reply.code(error.statusCode).send({ error: error.message });
                throw error;
              }
            });
          },
        });
        return app;
      });
      try {
        const tokens = await refreshDb.$transaction((tx) =>
          issueSession(tx, config, accountId, 'Browser approval fixture'),
        );
        const transport: Transport = async (path, body, access, method) => {
          const response = await apps[0].inject({
            method: (method || (body ? 'POST' : 'GET')) as 'POST' | 'GET',
            url: path,
            payload: body,
            headers: access ? { authorization: 'Bearer ' + access } : {},
          });
          if (response.statusCode >= 400) throw new Error('Account request rejected');
          return response.json();
        };
        const browser = new AccountClient(transport);
        browser.capabilities = {
          serverId: config.serverId,
          protocol: 2,
          features: { browserLogin: true },
        };
        browser.account = {
          id: accountId,
          email: 'review@example.test',
          username: 'review',
          displayName: 'Synthetic review',
          vaultVersion: 1,
        };
        browser.bundle = bundle;
        browser.unlocked = { masterKey, secrets };
        browser.adoptTokens(tokens);
        const created = await newBrowserLogin({
          serverId: config.serverId,
          serverUrl: config.publicUrl,
          redirectUri: 'app.ultratasks://account-login',
          deviceName: 'Concurrent PostgreSQL app',
        });
        const request = (await transport(
          '/browser-login/start',
          created.input,
        )) as Awaited<ReturnType<AccountClient['startBrowserLogin']>>['request'];
        await approveBrowserLogin(browser, request);
        const payload = {
          ticket: request.ticket,
          state: request.state,
          verifier: created.verifier,
          serverId: config.serverId,
        };
        const responses = await Promise.all(
          apps.map((app) =>
            app.inject({ method: 'POST', url: '/browser-login/poll', payload }),
          ),
        );
        expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 401]);
        const winner = responses
          .find((r) => r.statusCode === 200)!
          .json<{ tokens: Tokens }>();
        expect(
          (
            await authenticateAccount(
              refreshDb,
              config,
              'Bearer ' + winner.tokens.accessToken,
            )
          ).account_id,
        ).toBe(accountId);
        const [count] = await refreshDb.$queryRaw<{ count: bigint }[]>(
          Prisma.sql`SELECT count(*) AS count FROM ultra_sessions WHERE account_id=${accountId} AND device_name='Concurrent PostgreSQL app'`,
        );
        expect(Number(count.count)).toBe(1);
        const [pending] = await refreshDb.$queryRaw<{ count: bigint }[]>(
          Prisma.sql`SELECT count(*) AS count FROM ultra_challenges WHERE digest=${digest(request.ticket)}`,
        );
        expect(Number(pending.count)).toBe(0);
      } finally {
        config.authEngine = 'better-auth';
        await Promise.all(apps.map((app) => app.close()));
      }
    },
  );

  it('proves the original account FK deadlocks a refresh against account security', async () => {
    await refreshDb.$executeRawUnsafe(`ALTER TABLE ultra_better_auth_sessions
      ADD CONSTRAINT better_auth_review_account_fk FOREIGN KEY (account_id)
      REFERENCES ultra_accounts(id) ON DELETE CASCADE`);
    const outcomes = await raceRefreshWithSecurityChange();
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ code: 'P2010', meta: { code: '40P01' } });
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  });

  it('refreshes without the redundant FK and preserves revocation and account cascade', async () => {
    const outcomes = await raceRefreshWithSecurityChange();
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    const refreshed = outcomes[0];
    if (refreshed.status !== 'fulfilled') throw refreshed.reason;
    expect(refreshed.value!.accessToken).toMatch(/^utba1_/);
    expect(refreshed.value!.refreshToken).not.toBe(refreshToken);
    const accessRows = await refreshDb.$queryRaw<
      {
        session_id: string;
        account_id: string;
        token_hash: string;
      }[]
    >(
      Prisma.sql`SELECT session_id,account_id,token_hash FROM ultra_better_auth_sessions`,
    );
    expect(accessRows).toEqual([
      {
        session_id: session.id,
        account_id: accountId,
        token_hash: digest(refreshed.value!.accessToken.slice('utba1_'.length)),
      },
    ]);
    const [receipt] = await refreshDb.$queryRaw<{ used: boolean }[]>(
      Prisma.sql`SELECT used FROM ultra_refresh_tokens WHERE digest=${digest(refreshToken)}`,
    );
    expect(receipt.used).toBe(true);
    const [native] = await refreshDb.$queryRaw<{ revoked: boolean }[]>(
      Prisma.sql`SELECT revoked FROM ultra_sessions WHERE id=${session.id}`,
    );
    expect(native.revoked).toBe(true);
    await expect(
      authenticateAccount(refreshDb, config, 'Bearer ' + refreshed.value!.accessToken),
    ).rejects.toMatchObject({ statusCode: 401 });
    await refreshDb.$executeRaw(
      Prisma.sql`DELETE FROM ultra_accounts WHERE id=${accountId}`,
    );
    const [remaining] = await refreshDb.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT count(*) AS count FROM ultra_better_auth_sessions`,
    );
    expect(Number(remaining.count)).toBe(0);
  });
});
