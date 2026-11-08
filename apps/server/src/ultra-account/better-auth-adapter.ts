import { createAdapterFactory, type Where } from 'better-auth/adapters';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { type AccountRow, type UltraDb } from './store';

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const unsupported = (): never => {
  throw new Error('Operation outside the Ultra Tasks Better Auth session adapter');
};
const predicate = (where: Where[] = []): Prisma.Sql => {
  if (!where.length) return unsupported();
  return Prisma.join(
    where.map((part) => {
      if (part.connector === 'OR' || (part.operator && part.operator !== 'eq'))
        return unsupported();
      switch (part.field) {
        case 'token':
          return Prisma.sql`a.token_hash=${hash(String(part.value))}`;
        case 'id':
          return Prisma.sql`a.id=${part.value}`;
        case 'userId':
          return Prisma.sql`a.account_id=${part.value}`;
        case 'nativeSessionId':
          return Prisma.sql`a.session_id=${part.value}`;
        default:
          return unsupported();
      }
    }),
    ' AND ',
  );
};

/** Session-only port. Account/password/factor writes remain in the reviewed v2 flow. */
export const ultraBetterAuthAdapter = (db: UltraDb) => {
  const read = async (model: string, where?: Where[]) => {
    if (model === 'user') {
      if (where?.length !== 1 || where[0].field !== 'id') return unsupported();
      const rows = await db.$queryRaw<AccountRow[]>(
        Prisma.sql`SELECT * FROM ultra_accounts WHERE id=${String(where[0].value)}`,
      );
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        emailVerified: row.verified,
        name: row.display_name,
        image: null,
        createdAt: new Date(Number(row.created_at)).toISOString(),
        updatedAt: new Date(Number(row.created_at)).toISOString(),
      }));
    }
    if (model !== 'session') return unsupported();
    const rows = await db.$queryRaw<{ data: Record<string, unknown> }[]>(
      Prisma.sql`SELECT a.data FROM ultra_better_auth_sessions a
        JOIN ultra_sessions s ON s.id=a.session_id AND s.account_id=a.account_id
        WHERE ${predicate(where)} AND s.revoked=false
          AND s.expires_at>${BigInt(Date.now())}
          AND s.idle_expires_at>${BigInt(Date.now())}`,
    );
    const token = where?.find((part) => part.field === 'token')?.value;
    // Only the caller's presented token is returned. Plaintext tokens are not stored.
    return rows.map((row) => ({ ...row.data, token: token ?? '' }));
  };
  return createAdapterFactory({
    config: {
      adapterId: 'ultra-tasks-sessions',
      adapterName: 'Ultra Tasks session compatibility adapter',
      supportsJSON: true,
      supportsDates: false,
      transaction: false,
    },
    adapter: () => ({
      create: async ({ model, data }) => {
        if (model !== 'session') return unsupported();
        const { token, ...stored } = data;
        if (typeof token !== 'string' || typeof data.nativeSessionId !== 'string')
          return unsupported();
        await db.$executeRaw(
          Prisma.sql`DELETE FROM ultra_better_auth_sessions WHERE session_id=${data.nativeSessionId}`,
        );
        await db.$executeRaw(
          Prisma.sql`INSERT INTO ultra_better_auth_sessions
            (id,session_id,account_id,token_hash,expires_at,data)
            VALUES (${String(data.id)},${data.nativeSessionId},${String(data.userId)},
              ${hash(token)},${BigInt(Date.parse(String(data.expiresAt)))},
              ${JSON.stringify(stored)}::jsonb)`,
        );
        return data;
      },
      findOne: async <T>({ model, where }: { model: string; where: Where[] }) =>
        ((await read(model, where))[0] ?? null) as T | null,
      findMany: async <T>({ model, where }: { model: string; where?: Where[] }) =>
        (await read(model, where)) as T[],
      update: async () => unsupported(),
      updateMany: async () => unsupported(),
      delete: async ({ model, where }) => {
        if (model !== 'session') return unsupported();
        await db.$executeRaw(
          Prisma.sql`DELETE FROM ultra_better_auth_sessions a WHERE ${predicate(where)}`,
        );
      },
      deleteMany: async ({ model, where }) => {
        if (model !== 'session') return unsupported();
        return db.$executeRaw(
          Prisma.sql`DELETE FROM ultra_better_auth_sessions a WHERE ${predicate(where)}`,
        );
      },
      count: async ({ model, where }) => (await read(model, where)).length,
    }),
  });
};
