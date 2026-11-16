import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { AccountError, authenticateAccount, type UltraConfig } from './security';
import { one, type UltraDb, type UltraTransaction } from './store';

const MAX_FEEDS = 10;
const MAX_BYTES = 1024 * 1024;
const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
const enabled = (): boolean => process.env.ULTRA_CALENDAR_FEEDS_ENABLED === 'true';
const privacy = z.enum(['busy', 'titles']);
const identifier = z.string().uuid();
const feedBody = z
  .string()
  .max(MAX_BYTES)
  .refine(
    (text) =>
      Buffer.byteLength(text) <= MAX_BYTES &&
      text.startsWith('BEGIN:VCALENDAR\r\n') &&
      text.endsWith('END:VCALENDAR\r\n') &&
      !/\r\n(?:DESCRIPTION|ATTACH|URL|LOCATION|ORGANIZER|ATTENDEE)[;:]/i.test(text),
    'Invalid or oversized calendar',
  );
interface FeedRow {
  id: string;
  account_id: string;
  label: string;
  privacy: 'busy' | 'titles';
  token_hash: string;
  revision: number;
  generation: number;
  body: string;
  updated_at: bigint;
}
type Options = { db: UltraDb; transaction: UltraTransaction; config: UltraConfig };
const metadata = (row: FeedRow) => ({
  id: row.id,
  label: row.label,
  privacy: row.privacy,
  revision: row.revision,
  generation: row.generation,
});

/** Optional plaintext publications: never reads the encrypted sync tables. */
export const registerCalendarFeeds = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  if (!enabled()) return;
  const { db, transaction, config } = options;
  const url = (token: string) =>
    `${config.publicUrl.replace(/\/$/, '')}/cal/${token}.ics`;
  const authenticated =
    (run: (accountId: string, request: FastifyRequest) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const session = await authenticateAccount(
          db,
          config,
          request.headers.authorization,
        );
        return await run(session.account_id, request);
      } catch (error) {
        if (error instanceof AccountError)
          return reply.code(error.statusCode).send({ error: error.message });
        if (error instanceof ZodError)
          return reply.code(400).send({ error: 'Invalid calendar publication' });
        throw error;
      }
    };
  app.get(
    '/calendar-feeds',
    authenticated(async (accountId) => ({
      feeds: (
        await db.$queryRaw<FeedRow[]>(
          Prisma.sql`SELECT id,label,privacy,revision,generation FROM ultra_calendar_feeds WHERE account_id=${accountId} ORDER BY id`,
        )
      ).map(metadata),
    })),
  );
  app.post(
    '/calendar-feeds',
    {
      bodyLimit: MAX_BYTES + 65536,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    authenticated(async (accountId, request) => {
      const input = z
        .object({
          label: z.string().trim().min(1).max(100),
          privacy: privacy.default('busy'),
          body: feedBody,
          consent: z.literal(true),
        })
        .parse(request.body);
      const token = randomBytes(32).toString('base64url');
      return transaction(async (tx) => {
        // Serialize the per-account quota, including creates from other devices.
        const account = await one(
          tx,
          Prisma.sql`SELECT id FROM ultra_accounts WHERE id=${accountId} FOR UPDATE`,
        );
        if (!account) throw new AccountError(401);
        const count = await one<{ total: bigint }>(
          tx,
          Prisma.sql`SELECT count(*) AS total FROM ultra_calendar_feeds WHERE account_id=${accountId}`,
        );
        if (Number(count?.total) >= MAX_FEEDS)
          throw new AccountError(409, 'Calendar publication limit reached');
        const row = await one<FeedRow>(
          tx,
          Prisma.sql`INSERT INTO ultra_calendar_feeds (id,account_id,label,privacy,token_hash,body,updated_at) VALUES (${randomUUID()},${accountId},${input.label},${input.privacy},${tokenHash(token)},${input.body},${BigInt(Date.now())}) RETURNING *`,
        );
        return { ...metadata(row!), url: url(token) };
      });
    }),
  );
  app.put(
    '/calendar-feeds/:id',
    { bodyLimit: MAX_BYTES + 65536 },
    authenticated(async (accountId, request) => {
      const id = identifier.parse((request.params as { id: string }).id);
      const input = z
        .object({
          body: feedBody,
          revision: z.number().int().min(1).max(2147483646),
          generation: z.number().int().positive(),
        })
        .parse(request.body);
      const row = await one<FeedRow>(
        db,
        Prisma.sql`UPDATE ultra_calendar_feeds SET body=${input.body},revision=${input.revision},updated_at=${BigInt(Date.now())} WHERE id=${id} AND account_id=${accountId} AND generation=${input.generation} AND revision=${input.revision - 1} RETURNING *`,
      );
      if (!row)
        throw new AccountError(
          409,
          'Publication changed or stopped; reload before publishing',
        );
      return metadata(row);
    }),
  );
  app.post(
    '/calendar-feeds/:id/rotate',
    authenticated(async (accountId, request) => {
      const id = identifier.parse((request.params as { id: string }).id);
      const token = randomBytes(32).toString('base64url');
      // Rotation fences queued uploads from the previous publisher generation.
      const row = await one<FeedRow>(
        db,
        Prisma.sql`UPDATE ultra_calendar_feeds SET token_hash=${tokenHash(token)},generation=generation+1,updated_at=${BigInt(Date.now())} WHERE id=${id} AND account_id=${accountId} RETURNING *`,
      );
      if (!row) throw new AccountError(404);
      return { ...metadata(row), url: url(token) };
    }),
  );
  app.delete(
    '/calendar-feeds/:id',
    authenticated(async (accountId, request) => {
      const id = identifier.parse((request.params as { id: string }).id);
      await db.$executeRaw(
        Prisma.sql`DELETE FROM ultra_calendar_feeds WHERE id=${id} AND account_id=${accountId}`,
      );
      return { deleted: true };
    }),
  );
};

export const registerPublicCalendarFeeds = async (
  app: FastifyInstance,
  db: UltraDb,
): Promise<void> => {
  if (!enabled()) return;
  app.get(
    '/cal/:token.ics',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      // Every response must revalidate: revoked URLs must never serve a cached body.
      reply
        .header('Cache-Control', 'private, no-cache, must-revalidate')
        .header('X-Robots-Tag', 'noindex, nofollow')
        .header('Referrer-Policy', 'no-referrer');
      const token = (request.params as { token: string }).token;
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return reply.code(404).send();
      const hash = tokenHash(token);
      const row = await one<FeedRow>(
        db,
        Prisma.sql`SELECT * FROM ultra_calendar_feeds WHERE token_hash=${hash}`,
      );
      if (
        !row ||
        !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(row.token_hash, 'hex'))
      )
        return reply.code(404).send();
      const etag = `"${createHash('sha256').update(row.body).digest('hex')}"`;
      reply
        .header('ETag', etag)
        .header('Last-Modified', new Date(Number(row.updated_at)).toUTCString())
        .type('text/calendar; charset=utf-8');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.send(row.body);
    },
  );
};
