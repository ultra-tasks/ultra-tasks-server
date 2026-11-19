import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createHarness } from './ultra-account.helper';
import { NO_ABSOLUTE_EXPIRY, digest } from '../src/ultra-account/security';
import { encodeRefresh } from '../src/ultra-account/refresh-token';
import { randomKey } from '@ultra-tasks/account-crypto';

// Production-strength Argon2/OPAQUE can exceed the default 5s under parallel suite load.
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

const DAY = 86400000;

describe.each(['native', 'better-auth'] as const)(
  'session policy with %s sessions: sliding lifetime, caps and generation refresh tokens',
  (authEngine) => {
    let h: Awaited<ReturnType<typeof createHarness>>;
    beforeEach(async () => {
      h = await createHarness({ authEngine, privateOnly: true });
    });
    afterEach(async () => {
      vi.useRealTimers();
      await h.close();
    });
    /** Freezes the clock at the current instant so a test can move it by days. */
    const freeze = () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now());
    };
    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
    interface SessionRow {
      id: string;
      created_at: number;
      auth_at: number;
      expires_at: number;
      idle_expires_at: number;
      revoked: boolean;
      refreshed_at: number;
      refresh_generation: number | null;
    }
    const session = async (): Promise<SessionRow> => {
      const { rows } = await h.database.query<SessionRow>(
        'SELECT id,created_at,auth_at,expires_at,idle_expires_at,revoked,refreshed_at,refresh_generation FROM ultra_sessions ORDER BY created_at DESC',
      );
      return Object.fromEntries(
        Object.entries(rows[0]).map(([key, value]) => [
          key,
          value === null || typeof value === 'boolean' || key === 'id'
            ? value
            : Number(value),
        ]),
      ) as unknown as SessionRow;
    };
    /** Every row of the legacy receipt table: generation sessions never write one. */
    const receipts = async (): Promise<number> =>
      Number(
        (
          await h.database.query<{ n: number }>(
            'SELECT count(*) AS n FROM ultra_refresh_tokens',
          )
        ).rows[0].n,
      );
    const generationOf = (refreshToken: string): number =>
      Buffer.from(refreshToken, 'base64url').readUInt32BE(16);
    const rotate = (refreshToken: string) =>
      h.transport('/sessions/refresh', { refreshToken }) as Promise<{
        accessToken: string;
        refreshToken: string;
      }>;

    it('issues 180-day idle and 1095-day absolute sessions and advertises sliding lifetimes', async () => {
      await h.register();
      const issued = await session();
      expect(issued.idle_expires_at - issued.created_at).toBe(180 * DAY);
      expect(issued.expires_at - issued.created_at).toBe(1095 * DAY);
      const capabilities = await h.client().init();
      expect(capabilities.features).toMatchObject({
        sessionLifetime: 'sliding-v1',
        trustedDevices: true,
      });
    });

    it('keeps a session in regular use far beyond the old 90 days and ends an unused one at the idle limit', async () => {
      const { client } = await h.register();
      const issued = await session();
      freeze();
      // Eight 60-day gaps: 480 days of regular use, each one a refresh of an expired access token.
      for (let i = 0; i < 8; i++) {
        advance(60 * DAY);
        await client.request('/me');
        const renewed = await session();
        expect(renewed.expires_at).toBe(issued.expires_at);
        expect(renewed.idle_expires_at).toBe(Date.now() + 180 * DAY);
        expect(renewed.auth_at).toBe(issued.auth_at);
      }
      advance(179 * DAY);
      await client.request('/me');
      advance(181 * DAY);
      await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    });

    it('never lets refresh move the absolute cap, and stops at it even while the session is active', async () => {
      h.config.sessionMaxDays = 365;
      const { client } = await h.register('capped@example.test', 'capped');
      const issued = await session();
      expect(issued.expires_at - issued.created_at).toBe(365 * DAY);
      freeze();
      for (let i = 0; i < 3; i++) {
        advance(100 * DAY);
        await client.request('/me');
      }
      // Day 300: the sliding window would reach day 480, but the cap is day 365.
      expect((await session()).idle_expires_at).toBe(issued.expires_at);
      advance(100 * DAY);
      await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    });

    it('applies the default 1095-day cap to a session in daily use', async () => {
      const { client } = await h.register();
      freeze();
      for (let i = 0; i < 12; i++) {
        advance(90 * DAY);
        await client.request('/me');
      }
      advance(90 * DAY);
      await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    });

    it('removes the absolute cap when it is configured as zero', async () => {
      h.config.sessionMaxDays = 0;
      const { client } = await h.register('forever@example.test', 'forever');
      expect((await session()).expires_at).toBe(NO_ABSOLUTE_EXPIRY);
      freeze();
      // 14 x 90 days is longer than the default cap; only inactivity can end this session.
      for (let i = 0; i < 14; i++) {
        advance(90 * DAY);
        await client.request('/me');
      }
      expect(await client.request('/me')).toBeDefined();
      advance(181 * DAY);
      await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    });

    it('honors a shorter operator idle window at issue and at refresh', async () => {
      h.config.sessionIdleDays = 30;
      const { client } = await h.register('short@example.test', 'short');
      const issued = await session();
      expect(issued.idle_expires_at - issued.created_at).toBe(30 * DAY);
      freeze();
      advance(25 * DAY);
      await client.request('/me');
      expect((await session()).idle_expires_at).toBe(Date.now() + 30 * DAY);
      advance(31 * DAY);
      await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    });

    it('leaves a session issued before this policy at its stored absolute expiry; refresh recomputes only the idle window', async () => {
      const { client } = await h.register();
      await h.database.query(
        'UPDATE ultra_sessions SET expires_at=created_at+$1, idle_expires_at=created_at+$2',
        [90 * DAY, 30 * DAY],
      );
      const legacy = await session();
      freeze();
      advance(20 * DAY);
      await client.request('/me');
      const renewed = await session();
      expect(renewed.expires_at).toBe(legacy.created_at + 90 * DAY);
      expect(renewed.idle_expires_at).toBe(renewed.expires_at);
      advance(71 * DAY);
      await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    });

    it('does not renew the recent sign-in window: refresh never turns an old sign-in into a fresh authorization', async () => {
      const { client } = await h.register();
      freeze();
      advance(11 * 60 * 1000);
      const before = await session();
      // The client refreshes its stale access token first, then the sensitive request is refused.
      await expect(client.request('/factors/totp/start', {})).rejects.toMatchObject({
        status: 403,
        message: 'Sign in again before changing account security',
      });
      expect((await session()).auth_at).toBe(before.auth_at);
      // The refresh itself happened: the session moved to its next generation.
      expect((await session()).refresh_generation).toBe(1);
      expect((await session()).refreshed_at).toBe(Date.now());
    });

    it('issues self-identifying generation tokens and writes nothing per refresh', async () => {
      const { client } = await h.register();
      const first = client.tokens!.refreshToken;
      // 36 bytes: the session UUID, a big-endian generation and a 16-byte MAC.
      expect(first).toMatch(/^[A-Za-z0-9_-]{48}$/);
      const raw = Buffer.from(first, 'base64url');
      expect(raw).toHaveLength(36);
      const issued = await session();
      expect(raw.subarray(0, 16).toString('hex')).toBe(issued.id.replace(/-/g, ''));
      expect(generationOf(first)).toBe(0);
      expect(issued.refresh_generation).toBe(0);
      expect(issued.refreshed_at).toBe(issued.created_at);
      freeze();
      let current = first;
      for (let i = 1; i <= 25; i++) {
        advance(10 * 60 * 1000);
        current = (await rotate(current)).refreshToken;
        expect(generationOf(current)).toBe(i);
      }
      const rotated = await session();
      expect(rotated.refresh_generation).toBe(25);
      expect(rotated.refreshed_at).toBe(Date.now());
      // Storage is constant: a generation session never has a token row, however often it refreshes.
      expect(await receipts()).toBe(0);
      expect(
        JSON.stringify((await h.database.query('SELECT * FROM ultra_sessions')).rows),
      ).not.toContain(current);
    });

    it('a thief rotating a stolen token many times cannot erase reuse detection: the victim replaying it revokes the session', async () => {
      const { client } = await h.register();
      const stolen = client.tokens!.refreshToken;
      freeze();
      let thief = stolen;
      // More rotations than any count-based receipt window could cover.
      for (let i = 0; i < 12; i++) {
        advance(10 * 60 * 1000);
        thief = (await rotate(thief)).refreshToken;
      }
      expect((await session()).revoked).toBe(false);
      // The victim's own client still holds the original token: replaying it is reuse, however
      // many rotations ago it was issued. The session ends and so does the thief's chain.
      await expect(rotate(stolen)).rejects.toMatchObject({ status: 401 });
      expect((await session()).revoked).toBe(true);
      await expect(rotate(thief)).rejects.toMatchObject({ status: 401 });
      await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    });

    it('revokes on the replay of any older generation, not only the latest one', async () => {
      const { client } = await h.register();
      const tokens = [client.tokens!.refreshToken];
      for (let i = 0; i < 6; i++)
        tokens.push((await rotate(tokens[tokens.length - 1])).refreshToken);
      expect(generationOf(tokens[6])).toBe(6);
      // Neither the newest consumed nor the oldest: generation 2 of 6.
      await expect(rotate(tokens[2])).rejects.toMatchObject({ status: 401 });
      expect((await session()).revoked).toBe(true);
      // Every other generation, including the live one, is now dead.
      for (const dead of [tokens[0], tokens[5], tokens[6]])
        await expect(rotate(dead)).rejects.toMatchObject({ status: 401 });
    });

    it('refuses forged, foreign and future tokens without touching any session', async () => {
      const { client } = await h.register();
      const { client: other } = await h.register('other@example.test', 'otheruser');
      const real = client.tokens!.refreshToken;
      const snapshot = async () =>
        JSON.stringify(
          (await h.database.query('SELECT * FROM ultra_sessions ORDER BY id')).rows,
        );
      const before = await snapshot();
      const bytes = Buffer.from(real, 'base64url');
      const flipped = (index: number) => {
        const copy = Buffer.from(bytes);
        copy[index] ^= 0x01;
        return copy.toString('base64url');
      };
      const id = (await session()).id;
      const forged = [
        flipped(0), // another session id behind the same MAC
        flipped(19), // another generation behind the same MAC
        flipped(20), // damaged MAC
        flipped(35),
        // The right session, a perfectly formed token, but the wrong MAC: swapped from another session.
        Buffer.concat([
          bytes.subarray(0, 20),
          Buffer.from(other.tokens!.refreshToken, 'base64url').subarray(20),
        ]).toString('base64url'),
        // A valid MAC from this server for a session that does not exist.
        encodeRefresh(h.config, crypto.randomUUID(), 0),
        // A valid MAC for the real session but a generation it has not reached yet.
        encodeRefresh(h.config, id, 1),
        encodeRefresh(h.config, id, 4000000000),
      ];
      for (const token of forged)
        await expect(rotate(token)).rejects.toMatchObject({ status: 401 });
      // Anything that is not 43 or 48 characters never reaches the handler.
      for (const token of [
        real.slice(1),
        real + 'A',
        'short',
        real.slice(0, 43) + '!!!!!',
      ])
        await expect(rotate(token)).rejects.toMatchObject({ status: 400 });
      expect(await snapshot()).toBe(before);
      // The genuine token is untouched by all of that and still rotates.
      expect(generationOf((await rotate(real)).refreshToken)).toBe(1);
    });

    it('migrates a legacy random token once, then holds generation tokens only; replaying the legacy token revokes', async () => {
      const { client } = await h.register();
      const issued = await session();
      // Make it a session issued before generations existed: a random 43-character token.
      const legacy = randomKey();
      await h.database.query(
        'UPDATE ultra_sessions SET refresh_generation=NULL, refreshed_at=0',
      );
      await h.database.query(
        'INSERT INTO ultra_refresh_tokens(digest,session_id,used) VALUES ($1,$2,false)',
        [digest(legacy), issued.id],
      );
      freeze();
      advance(5 * 60 * 1000);
      const migrated = await rotate(legacy);
      expect(migrated.refreshToken).toMatch(/^[A-Za-z0-9_-]{48}$/);
      expect(generationOf(migrated.refreshToken)).toBe(0);
      const moved = await session();
      expect(moved.refresh_generation).toBe(0);
      expect(moved.refreshed_at).toBe(Date.now());
      // The legacy receipt is consumed; nothing new was written.
      expect(await receipts()).toBe(1);
      expect(
        (await h.database.query('SELECT 1 FROM ultra_refresh_tokens WHERE used=true'))
          .rows,
      ).toHaveLength(1);
      // The chain continues with generation tokens.
      expect(generationOf((await rotate(migrated.refreshToken)).refreshToken)).toBe(1);
      // Replaying the legacy token is reuse.
      await expect(rotate(legacy)).rejects.toMatchObject({ status: 401 });
      expect((await session()).revoked).toBe(true);
      await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    });

    it('never lets a legacy token reset a session that already holds generations', async () => {
      const { client } = await h.register();
      let current = client.tokens!.refreshToken;
      for (let i = 0; i < 3; i++) current = (await rotate(current)).refreshToken;
      const id = (await session()).id;
      // An unused legacy receipt cannot normally exist next to a generation counter. If one did,
      // honoring it would rewind the counter and make older generation tokens valid again.
      const stray = randomKey();
      await h.database.query(
        'INSERT INTO ultra_refresh_tokens(digest,session_id,used) VALUES ($1,$2,false)',
        [digest(stray), id],
      );
      await expect(rotate(stray)).rejects.toMatchObject({ status: 401 });
      const after = await session();
      expect(after.refresh_generation).toBe(3);
      expect(after.revoked).toBe(false);
      expect(generationOf((await rotate(current)).refreshToken)).toBe(4);
    });

    it('revokes the session when a consumed refresh token is replayed, with no leeway (lost-response case)', async () => {
      // If the response to a rotation is lost, the client retries the token the server already
      // consumed. Single-use rotation treats that as reuse and revokes the session: the client
      // must show a persistent reconnect state, not loop. This pins that behavior; a safe retry
      // would be a separate, security-reviewed design (docs/account-devices-and-sessions.md).
      const { client } = await h.register();
      const lost = client.tokens!.refreshToken;
      const rotated = await rotate(lost);
      await expect(rotate(lost)).rejects.toMatchObject({ status: 401 });
      expect((await session()).revoked).toBe(true);
      await expect(
        h.transport('/me', undefined, rotated.accessToken),
      ).rejects.toMatchObject({
        status: 401,
      });
      await expect(rotate(rotated.refreshToken)).rejects.toMatchObject({ status: 401 });
      // What an application sees: a terminal 401 on every account request.
      await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    });

    it('allows 30 live sessions per account, then refuses the next with a machine-readable reason', async () => {
      const { client } = await h.register();
      const accountId = client.account!.id;
      const now = Date.now();
      for (let i = 0; i < 28; i++)
        await h.db.$executeRaw(
          Prisma.sql`INSERT INTO ultra_sessions(id,account_id,device_name,created_at,auth_at,expires_at,idle_expires_at) VALUES (${crypto.randomUUID()},${accountId},${'Extra ' + i},${BigInt(now)},${BigInt(now)},${BigInt(now + 90 * DAY)},${BigInt(now + 30 * DAY)})`,
        );
      // 29 live sessions (more than the previous limit of 20): the thirtieth is still accepted.
      expect(await h.legacyLogin('alice')).toHaveProperty('accessToken');
      await expect(h.legacyLogin('alice')).rejects.toMatchObject({
        status: 409,
        code: 'session_limit',
      });
      await h.db.$executeRaw(
        Prisma.sql`UPDATE ultra_sessions SET revoked=true WHERE device_name='Extra 0'`,
      );
      expect(await h.legacyLogin('alice')).toHaveProperty('accessToken');
    });

    it('retires the least recently active stale session at the cap, never one in use, and refuses when all are recent', async () => {
      const { client } = await h.register();
      const accountId = client.account!.id;
      const now = Date.now();
      const insert = async (name: string, createdAt: number) => {
        const id = crypto.randomUUID();
        await h.db.$executeRaw(
          Prisma.sql`INSERT INTO ultra_sessions(id,account_id,device_name,created_at,auth_at,expires_at,idle_expires_at) VALUES (${id},${accountId},${name},${BigInt(createdAt)},${BigInt(createdAt)},${BigInt(now + 90 * DAY)},${BigInt(now + 30 * DAY)})`,
        );
        return id;
      };
      // The orphans of repeated sign-ins: 29 down to 2 days without any activity (stale, yet
      // not so old that retiring one makes it eligible for the monthly purge of revoked rows).
      for (let i = 0; i < 28; i++) await insert('Orphan ' + i, now - (29 - i) * DAY);
      // The oldest session of all, but refreshed an hour ago: in use, so never a candidate.
      const inUse = await insert('In use', now - 100 * DAY);
      await h.database.query('UPDATE ultra_sessions SET refreshed_at=$1 WHERE id=$2', [
        now - 60 * 60 * 1000,
        inUse,
      ]);
      // The registration session plus 29 more: exactly 30 live sessions.
      const live = async () =>
        Number(
          (
            await h.database.query<{ n: number }>(
              'SELECT count(*) AS n FROM ultra_sessions WHERE account_id=$1 AND revoked=false',
              [accountId],
            )
          ).rows[0].n,
        );
      const revoked = async () =>
        (
          await h.database.query<{ device_name: string }>(
            'SELECT device_name FROM ultra_sessions WHERE account_id=$1 AND revoked=true ORDER BY device_name',
            [accountId],
          )
        ).rows.map((row) => row.device_name);
      expect(await live()).toBe(30);
      for (let i = 0; i < 3; i++)
        expect(await h.legacyLogin('alice')).toHaveProperty('accessToken');
      // Each sign-in retired exactly the oldest stale orphan, so the count never exceeds 30.
      expect(await revoked()).toEqual(['Orphan 0', 'Orphan 1', 'Orphan 2']);
      expect(await live()).toBe(30);

      // When every live session was active within the last day nothing may be retired.
      await h.database.query(
        'UPDATE ultra_sessions SET created_at=$1 WHERE account_id=$2 AND revoked=false',
        [now, accountId],
      );
      await expect(h.legacyLogin('alice')).rejects.toMatchObject({
        status: 409,
        code: 'session_limit',
      });
      expect(await revoked()).toEqual(['Orphan 0', 'Orphan 1', 'Orphan 2']);
    });

    it('purges revoked sessions a month after their last activity, and lists at most 100 with the current one first', async () => {
      const { client } = await h.register();
      const accountId = client.account!.id;
      const now = Date.now();
      const addRevoked = (
        label: string,
        count: number,
        createdAgo: number,
        refreshedAgo: number,
      ) =>
        h.database.query(
          `INSERT INTO ultra_sessions(id,account_id,device_name,created_at,auth_at,expires_at,idle_expires_at,revoked,refreshed_at)
           SELECT gen_random_uuid()::text, $1, $2 || i, $3::bigint - i, $3::bigint - i, $4::bigint, $4::bigint, true, $5::bigint FROM generate_series(1, $6::int) AS i`,
          [
            accountId,
            label,
            now - createdAgo,
            now + 90 * DAY,
            refreshedAgo < 0 ? 0 : now - refreshedAgo,
            count,
          ],
        );
      // 110 revoked sessions from the last few days, 10 revoked long ago, and one that was
      // created long ago but refreshed last week, so its last activity is recent.
      await addRevoked('Recent ', 110, 3 * DAY, 3 * DAY);
      await addRevoked('Old ', 10, 45 * DAY, -1);
      await addRevoked('Active long ago ', 1, 90 * DAY, 7 * DAY);
      const list = await client.request<
        {
          id: string;
          current: boolean;
          revoked: boolean;
          deviceName: string;
          createdAt: number;
        }[]
      >('/sessions');
      expect(list).toHaveLength(100);
      expect(list[0].current).toBe(true);
      const created = list.slice(1).map((row) => row.createdAt);
      expect([...created].sort((a, b) => b - a)).toEqual(created);
      expect(list.slice(1).every((row) => row.revoked)).toBe(true);

      // The next sign-in sweeps: old revoked sessions go, recent and recently active ones stay.
      expect(await h.legacyLogin('alice')).toHaveProperty('accessToken');
      const names = (
        await h.database.query<{ device_name: string }>(
          'SELECT device_name FROM ultra_sessions WHERE account_id=$1 AND revoked=true',
          [accountId],
        )
      ).rows.map((row) => row.device_name);
      expect(names.filter((name) => name.startsWith('Old '))).toHaveLength(0);
      expect(names.filter((name) => name.startsWith('Recent '))).toHaveLength(110);
      expect(names.filter((name) => name.startsWith('Active long ago '))).toHaveLength(1);
    });
  },
);
