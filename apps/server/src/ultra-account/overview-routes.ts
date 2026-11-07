import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { AccountError, authenticateAccount, type UltraConfig } from './security';
import { one, type UltraDb } from './store';

/** Routing metadata and ciphertext sizes only; no task content enters the dashboard. */
export const registerAccountOverview = async (
  app: FastifyInstance,
  options: { db: UltraDb; config: UltraConfig },
): Promise<void> => {
  app.get('/overview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    try {
      const session = await authenticateAccount(
        options.db,
        options.config,
        request.headers.authorization,
      );
      const scope = await one<{
        id: string;
        state: string;
        sequence: number;
        records: bigint;
        bytes: bigint;
        history: bigint;
      }>(
        options.db,
        Prisma.sql`SELECT s.id,s.state,s.sequence,
          (SELECT count(*) FROM ultra_record_heads h WHERE h.scope_id=s.id) AS records,
          coalesce((SELECT sum(h.bytes) FROM ultra_record_heads h WHERE h.scope_id=s.id),0) AS bytes,
          coalesce((SELECT sum(octet_length(m.manifest::text)) FROM ultra_scope_mutations m WHERE m.scope_id=s.id),0) AS history
          FROM ultra_scopes s WHERE s.owner_id=${session.account_id} AND s.kind='personal'`,
      );
      return {
        server: { id: options.config.serverId, url: options.config.publicUrl },
        personal: scope
          ? {
              scopeId: scope.id,
              state: scope.state,
              sequence: scope.sequence,
              records: Number(scope.records),
              encryptedBytes: Number(scope.bytes),
              historyBytes: Number(scope.history),
            }
          : null,
        limits: {
          records: 50000,
          encryptedBytes: 32 * 1024 * 1024,
          historyBytes: 128 * 1024 * 1024,
        },
      };
    } catch (error) {
      if (error instanceof AccountError)
        return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
};
