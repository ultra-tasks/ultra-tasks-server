import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type WebSocket from 'ws';
import { z, ZodError } from 'zod';
import {
  AccountError,
  authenticateAccount,
  digest,
  token,
  type UltraConfig,
} from './security';
import { one, type UltraDb, type UltraTransaction } from './store';
import { liveSession, lockScope } from './scope-store';

interface Stamp {
  scopeId: string;
  sequence: number;
  generation: number;
  epoch: number;
  controlVersion: number;
}
interface Peer {
  socket: WebSocket;
  accountId: string;
  sessionId: string;
  scopes: Set<string>;
  known: Map<string, string>;
  timer: ReturnType<typeof setTimeout>;
}
interface Ticket {
  session_id: string;
  account_id: string;
  scope_ids: string[];
}
const stamp = (row: {
  id: string;
  sequence: number;
  generation: number;
  epoch: number;
  control_version: number;
}): Stamp => ({
  scopeId: row.id,
  sequence: row.sequence,
  generation: row.generation,
  epoch: row.epoch,
  controlVersion: row.control_version,
});

/** One process, metadata-only notifications. PostgreSQL remains the source of truth. */
export class UltraRealtimeHub {
  private readonly peers = new Set<Peer>();
  private queue: Promise<void> = Promise.resolve();
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(
    private readonly db: UltraDb,
    private readonly privateOnly = false,
  ) {}
  get size(): number {
    return this.peers.size;
  }
  start(): void {
    this.heartbeat = setInterval(() => {
      void this.refresh();
    }, 10000);
    this.heartbeat.unref?.();
  }
  add(socket: WebSocket, ticket: Ticket): void {
    if ([...this.peers].filter((p) => p.accountId === ticket.account_id).length >= 100) {
      socket.close(4008, 'Connection limit');
      return;
    }
    const peer: Peer = {
      socket,
      accountId: ticket.account_id,
      sessionId: ticket.session_id,
      scopes: new Set(ticket.scope_ids),
      known: new Map(),
      timer: setTimeout(() => socket.close(4001, 'Refresh session'), 8 * 60000),
    };
    peer.timer.unref?.();
    this.peers.add(peer);
    socket.on('close', () => {
      clearTimeout(peer.timer);
      this.peers.delete(peer);
    });
    socket.on('error', () => socket.close());
    socket.on('message', () => socket.close(1008, 'Use authenticated scope tickets'));
    void this.refresh();
  }
  refresh(): Promise<void> {
    if (!this.peers.size) return Promise.resolve();
    const result = this.queue.then(() => this.scan());
    this.queue = result.catch(() => {
      for (const peer of this.peers) peer.socket.close(1011, 'Authorization unavailable');
    });
    return this.queue;
  }
  private async scan(): Promise<void> {
    const peers = [...this.peers];
    if (!peers.length) return;
    const now = BigInt(Date.now());
    const sessions = await this.db.$queryRaw<{ id: string; account_id: string }[]>(
      Prisma.sql`SELECT id,account_id FROM ultra_sessions WHERE id IN (${Prisma.join([...new Set(peers.map((p) => p.sessionId))])}) AND revoked=false AND expires_at>${now} AND idle_expires_at>${now}`,
    );
    const live = new Map(sessions.map((s) => [s.id, s.account_id]));
    const scopeIds = [...new Set(peers.flatMap((p) => [...p.scopes]))];
    const rows = scopeIds.length
      ? await this.db.$queryRaw<
          {
            id: string;
            account_id: string;
            sequence: number;
            generation: number;
            epoch: number;
            control_version: number;
          }[]
        >(
          Prisma.sql`SELECT s.id,m.account_id,s.sequence,s.generation,s.epoch,s.control_version FROM ultra_scopes s JOIN ultra_scope_members m ON m.scope_id=s.id WHERE s.kind=${this.privateOnly ? 'personal' : 'project'} AND s.id IN (${Prisma.join(scopeIds)}) AND m.account_id IN (${Prisma.join([...new Set(peers.map((p) => p.accountId))])})`,
        )
      : [];
    const authorized = new Map(
      rows.map((row) => [row.account_id + ':' + row.id, stamp(row)]),
    );
    for (const peer of peers) {
      if (peer.socket.readyState !== 1) continue;
      if (live.get(peer.sessionId) !== peer.accountId) {
        peer.socket.close(4001, 'Session revoked');
        continue;
      }
      const initial = !peer.known.size;
      const current: Stamp[] = [];
      for (const id of peer.scopes) {
        const state = authorized.get(peer.accountId + ':' + id);
        if (!state) {
          peer.socket.send(JSON.stringify({ type: 'scope-revoked', scopeId: id }));
          peer.scopes.delete(id);
          peer.known.delete(id);
          continue;
        }
        const encoded = JSON.stringify(state);
        if (peer.known.get(id) !== encoded) current.push(state);
        peer.known.set(id, encoded);
      }
      if (initial || current.length)
        peer.socket.send(
          JSON.stringify({ type: initial ? 'ready' : 'scopes-changed', scopes: current }),
        );
    }
  }
  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const peer of this.peers) {
      clearTimeout(peer.timer);
      peer.socket.terminate();
    }
    this.peers.clear();
  }
}

export const registerUltraRealtime = async (
  app: FastifyInstance,
  options: {
    db: UltraDb;
    transaction: UltraTransaction;
    config: UltraConfig;
    hub: UltraRealtimeHub;
  },
): Promise<void> => {
  const { db, transaction, config, hub } = options;
  const tickets = new WeakMap<FastifyRequest, Ticket>();
  app.post(
    '/sync/socket-ticket',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      try {
        const { scopes } = z
          .object({ scopes: z.array(z.string().uuid()).min(1).max(100) })
          .strict()
          .parse(req.body);
        const session = await authenticateAccount(db, config, req.headers.authorization);
        const value = token();
        await transaction(async (tx) => {
          await liveSession(tx, session);
          for (const id of [...new Set(scopes)].sort()) {
            const { scope } = await lockScope(tx, id, session.account_id);
            if (scope.kind !== (config.privateOnly ? 'personal' : 'project'))
              throw new AccountError(
                403,
                'This scope does not support live subscriptions',
              );
          }
          await tx.$executeRaw(
            Prisma.sql`DELETE FROM ultra_socket_tickets WHERE expires_at<${BigInt(Date.now())}`,
          );
          await tx.$executeRaw(
            Prisma.sql`INSERT INTO ultra_socket_tickets(digest,session_id,account_id,scope_ids,expires_at) VALUES (${digest(value)},${session.id},${session.account_id},${JSON.stringify([...new Set(scopes)])}::jsonb,${BigInt(Date.now() + 15000)})`,
          );
        });
        return { ticket: value, expiresIn: 15 };
      } catch (error) {
        if (error instanceof ZodError)
          return reply.code(400).send({ error: 'Invalid subscription request' });
        if (error instanceof AccountError)
          return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    },
  );
  app.get(
    '/sync/events',
    {
      websocket: true,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      preValidation: async (req, reply) => {
        try {
          const { ticket } = z
            .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
            .strict()
            .parse(req.query);
          const record = await transaction(async (tx) => {
            const row = await one<Ticket>(
              tx,
              Prisma.sql`SELECT session_id,account_id,scope_ids FROM ultra_socket_tickets WHERE digest=${digest(ticket)} AND expires_at>${BigInt(Date.now())}`,
            );
            if (!row) throw new AccountError(401);
            const session = await one<{ id: string; account_id: string }>(
              tx,
              Prisma.sql`SELECT id,account_id FROM ultra_sessions WHERE id=${row.session_id} AND revoked=false AND expires_at>${BigInt(Date.now())} AND idle_expires_at>${BigInt(Date.now())} FOR UPDATE`,
            );
            if (!session || session.account_id !== row.account_id)
              throw new AccountError(401);
            const consumed = await tx.$executeRaw(
              Prisma.sql`DELETE FROM ultra_socket_tickets WHERE digest=${digest(ticket)} AND expires_at>${BigInt(Date.now())}`,
            );
            if (consumed !== 1) throw new AccountError(401);
            for (const id of [...row.scope_ids].sort()) {
              const { scope } = await lockScope(tx, id, row.account_id);
              if (scope.kind !== (config.privateOnly ? 'personal' : 'project'))
                throw new AccountError(403);
            }
            return row;
          });
          tickets.set(req, record);
        } catch (error) {
          reply
            .code(error instanceof AccountError ? error.statusCode : 401)
            .send({ error: 'Invalid or expired subscription ticket' });
        }
      },
    },
    (socket, req) => {
      const ticket = tickets.get(req);
      if (!ticket) {
        socket.close(4001, 'Invalid subscription');
        return;
      }
      tickets.delete(req);
      hub.add(socket, ticket);
    },
  );
  hub.start();
  app.addHook('onClose', async () => hub.stop());
};
