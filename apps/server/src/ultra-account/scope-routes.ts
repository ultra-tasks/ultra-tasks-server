import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import type { SyncRequestBudget } from './sync-request-budget';
import type { UltraRealtimeHub } from './realtime';
import {
  canonical,
  verify,
  type Membership,
  type Mutation,
} from '@ultra-tasks/account-crypto';
import { registerScopeRecovery } from './scope-recovery-routes';
import { registerPersonalReplacement } from './personal-replacement-routes';
import { registerPersonalMigrationRecovery } from './personal-migration-recovery-routes';
import { UltraMembershipSchema, UltraMutationSchema } from '@ultra-tasks/sync-contract';
import { AccountError, accountErrorBody, type UltraConfig } from './security';
import {
  accountById,
  accountByIdentifier,
  one,
  type UltraDb,
  type UltraTransaction,
} from './store';
import {
  commitMutation,
  liveSession,
  lockScope,
  putMember,
  scopeInfo,
  snapshot,
  changesSince,
  cursorMutationId,
  unsigned,
  validateMembership,
  type ScopeRow,
  type MemberRow,
} from './scope-store';

interface Options {
  db: UltraDb;
  transaction: UltraTransaction;
  config: UltraConfig;
  sendInviteMail?: (email: string) => Promise<boolean>;
  realtime: UltraRealtimeHub;
  requestBudget: SyncRequestBudget;
}
interface InviteRow {
  id: string;
  scope_id: string;
  recipient_id: string | null;
  email: string | null;
  role: 'editor' | 'viewer';
  expires_at: bigint;
  membership: Membership | null;
  state: 'pending' | 'provisioning' | 'accepted';
  request: Record<string, unknown>;
}
const id = z.string().uuid();
const params = (req: FastifyRequest) => z.object({ scopeId: id }).parse(req.params);
const inviteId = (req: FastifyRequest) =>
  z.object({ inviteId: id }).parse(req.params).inviteId;
const proof = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const historyChanged = (): AccountError =>
  new AccountError(
    409,
    'Sync history changed. Verified data and pending edits were retained on this device.',
    'SYNC_HISTORY_CHANGED',
  );

const matchesObservedHistory = async (
  db: UltraDb,
  scope: ScopeRow,
  after: number,
  afterMutation?: string,
): Promise<boolean> => {
  if (after > scope.sequence) throw historyChanged();
  if (afterMutation === undefined) return true;
  // A missing mutation may have aged out. A different mutation at that sequence
  // proves that this database continued from a different history.
  const observed = await one<{ id: string }>(
    db,
    Prisma.sql`SELECT id FROM ultra_scope_mutations WHERE scope_id=${scope.id} AND sequence=${after}`,
  );
  if (observed && observed.id !== afterMutation) throw historyChanged();
  return !!observed;
};

const oversizedWriteIndices = (error: ZodError): number[] | undefined => {
  const indices = new Set<number>();
  for (const issue of error.issues) {
    const [writes, index, record, payload, data] = issue.path;
    if (
      issue.path.length !== 5 ||
      writes !== 'writes' ||
      typeof index !== 'number' ||
      record !== 'record' ||
      payload !== 'payload' ||
      data !== 'data' ||
      (issue.code !== 'too_big' && issue.code !== 'custom')
    )
      return undefined;
    indices.add(index);
  }
  return indices.size ? [...indices] : undefined;
};

export const ultraScopeRoutes = async (
  app: FastifyInstance,
  { db, transaction, config, sendInviteMail, realtime, requestBudget }: Options,
): Promise<void> => {
  const auth = requestBudget.session;
  const route = (
    method: 'GET' | 'POST',
    url: string,
    run: (req: FastifyRequest) => Promise<unknown>,
  ) =>
    app.route({
      method,
      url,
      bodyLimit: 8 * 1024 * 1024,
      config: { rateLimit: false },
      onRequest: requestBudget.admitBearer,
      handler: async (req, reply) => {
        try {
          const result = await run(req);
          if (method !== 'GET') await realtime.refresh();
          return result;
        } catch (error) {
          if (error instanceof ZodError)
            return reply.code(400).send({ error: 'Invalid encrypted sync request' });
          if (error instanceof AccountError)
            return reply.code(error.statusCode).send(accountErrorBody(error));
          throw error;
        }
      },
    });
  const withScope = async <T>(
    req: FastifyRequest,
    write: boolean,
    run: (tx: UltraDb, scope: ScopeRow, member: MemberRow) => Promise<T>,
  ) => {
    const session = await auth(req);
    return transaction(async (tx) => {
      await liveSession(tx, session);
      const { scope, member } = await lockScope(
        tx,
        params(req).scopeId,
        session.account_id,
        write,
      );
      if (config.privateOnly && scope.kind !== 'personal')
        throw new AccountError(404, 'Sync scope unavailable');
      return run(tx, scope, member);
    });
  };
  const owner = (member: MemberRow) => {
    if (member.role !== 'owner')
      throw new AccountError(403, 'Only the owner can manage this project');
  };

  route('GET', '/scopes', async (req) => {
    const session = await auth(req);
    return transaction(async (tx) => {
      await liveSession(tx, session);
      const rows = await tx.$queryRaw<ScopeRow[]>(
        Prisma.sql`SELECT s.* FROM ultra_scopes s JOIN ultra_scope_members m ON m.scope_id=s.id WHERE m.account_id=${session.account_id} ORDER BY s.id`,
      );
      return {
        scopes: await Promise.all(
          rows
            .filter((row) => !config.privateOnly || row.kind === 'personal')
            .map((row) => scopeInfo(tx, row)),
        ),
      };
    });
  });
  route('POST', '/scopes', async (req) => {
    const body = z
      .object({
        kind: z.enum(['personal', 'project']),
        membership: UltraMembershipSchema,
        deviceId: id,
        migrating: z.boolean().default(false),
        replacesEmptyScopeId: id.optional(),
      })
      .strict()
      .parse(req.body);
    const session = await auth(req);
    if (body.replacesEmptyScopeId && (body.kind !== 'personal' || !body.migrating))
      throw new AccountError(400);
    if (config.privateOnly && body.kind !== 'personal')
      throw new AccountError(403, 'This server supports private account sync only');
    return transaction(async (tx) => {
      await liveSession(tx, session);
      const account = await accountById(tx, session.account_id);
      if (!account?.verified) throw new AccountError(403);
      let abandonedScopeId: string | undefined;
      if (body.kind === 'personal') {
        // Serialize first-device creation on the immutable account row.
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM ultra_accounts WHERE id=${session.account_id} FOR UPDATE`,
        );
        const previous = await one<ScopeRow>(
          tx,
          Prisma.sql`SELECT * FROM ultra_scopes WHERE owner_id=${session.account_id} AND kind='personal' FOR UPDATE`,
        );
        // A repeated request after a lost response returns the same new scope.
        if (
          previous &&
          (!body.replacesEmptyScopeId ||
            previous.id === body.membership.authorization.scopeId)
        )
          return scopeInfo(tx, previous);
        if (body.replacesEmptyScopeId) {
          if (
            previous?.id !== body.replacesEmptyScopeId ||
            previous.state !== 'migrating' ||
            previous.sequence !== 0
          )
            throw new AccountError(
              409,
              'The previous setup has already uploaded data or changed',
            );
          abandonedScopeId = previous.id;
        }
      }
      const count = await one<{ count: bigint }>(
        tx,
        Prisma.sql`SELECT count(*) AS count FROM ultra_scope_members WHERE account_id=${session.account_id}`,
      );
      if (Number(count?.count) >= (abandonedScopeId ? 102 : 101))
        throw new AccountError(413, 'Project limit reached');
      const a = body.membership.authorization;
      const scope: ScopeRow = {
        id: a.scopeId,
        kind: body.kind,
        owner_id: session.account_id,
        owner_key: account.bundle.signingPublicKey,
        epoch: 1,
        generation: 1,
        control_version: 1,
        sequence: 0,
        state: body.migrating ? 'migrating' : 'active',
        migration_device: body.migrating ? body.deviceId : null,
        rotation: null,
      };
      if (
        a.accountId !== session.account_id ||
        a.role !== 'owner' ||
        (body.kind === 'project' && body.migrating)
      )
        throw new AccountError(400);
      await validateMembership(tx, config, scope, body.membership);
      // A zero cursor means no transaction or record committed. Retire the old ID so an
      // older device cannot resume into the replacement when it eventually returns.
      if (abandonedScopeId)
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM ultra_scopes WHERE id=${abandonedScopeId}`,
        );
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_scopes (id,kind,owner_id,owner_key,state,migration_device) VALUES (${scope.id},${scope.kind},${scope.owner_id},${JSON.stringify(scope.owner_key)}::jsonb,${scope.state},${scope.migration_device})`,
      );
      await putMember(tx, scope.id, body.membership);
      return scopeInfo(tx, scope);
    });
  });
  route('GET', '/scopes/:scopeId/snapshot', (req) =>
    withScope(req, false, async (tx, scope) => ({
      ...(await snapshot(tx, scope)),
      cursorMutationId: await cursorMutationId(tx, scope),
    })),
  );
  route('GET', '/scopes/:scopeId/receipt', (req) =>
    withScope(req, false, async (tx, scope, member) => {
      const { deviceId, after, afterMutation } = z
        .object({
          deviceId: id,
          after: z.coerce.number().int().nonnegative().optional(),
          afterMutation: z.string().min(1).max(200).optional(),
        })
        .parse(req.query);
      if (after !== undefined)
        await matchesObservedHistory(tx, scope, after, afterMutation);
      const row = await one<{ counter: number; mutation_id: string; sequence: number }>(
        tx,
        Prisma.sql`SELECT counter,mutation_id,sequence FROM ultra_scope_receipts WHERE scope_id=${scope.id} AND account_id=${member.account_id} AND device_id=${deviceId}`,
      );
      return {
        counter: row?.counter ?? 0,
        mutationId: row?.mutation_id ?? null,
        sequence: row?.sequence ?? 0,
      };
    }),
  );
  route('GET', '/scopes/:scopeId/changes', (req) =>
    withScope(req, false, async (tx, scope, member) => {
      const {
        after,
        afterMutation,
        generation,
        controlVersion,
        delta,
        deviceId,
        afterCounter,
      } = z
        .object({
          after: z.coerce.number().int().nonnegative(),
          afterMutation: z.string().min(1).max(200).optional(),
          generation: z.coerce.number().int().positive(),
          controlVersion: z.coerce.number().int().positive().optional(),
          delta: z.literal('1').optional(),
          deviceId: id.optional(),
          afterCounter: z.coerce.number().int().positive().optional(),
        })
        .parse(req.query);
      const compact =
        controlVersion === scope.control_version && generation === scope.generation;
      const cursorMatches = await matchesObservedHistory(tx, scope, after, afterMutation);
      // The last write receipt can be ahead of the download cursor. A restore may
      // retain that cursor but lose an acknowledged write, even if sequences catch up.
      if (deviceId && afterCounter !== undefined) {
        const receipt = await one<{ counter: number }>(
          tx,
          Prisma.sql`SELECT counter FROM ultra_scope_receipts WHERE scope_id=${scope.id} AND account_id=${member.account_id} AND device_id=${deviceId}`,
        );
        if ((receipt?.counter ?? 0) < afterCounter) throw historyChanged();
      }
      const cursor = await cursorMutationId(tx, scope);
      if (cursorMatches && after === scope.sequence && generation === scope.generation)
        return {
          scope: await scopeInfo(tx, scope, compact),
          unchanged: true,
          cursorMutationId: cursor,
          ...(compact ? { controlUnchanged: true } : {}),
        };
      // A delta never crosses a generation: rekeying, ownership transfer and restore
      // re-encrypt or replace heads, so those clients need the complete snapshot.
      if (
        cursorMatches &&
        delta &&
        generation === scope.generation &&
        after < scope.sequence
      )
        return {
          ...(await changesSince(tx, scope, after, compact)),
          cursorMutationId: cursor,
        };
      return { ...(await snapshot(tx, scope, compact)), cursorMutationId: cursor };
    }),
  );
  route('POST', '/scopes/:scopeId/transactions', (req) =>
    withScope(req, true, (tx, scope, member) => {
      const parsed = UltraMutationSchema.safeParse(req.body);
      if (!parsed.success) {
        const indices =
          scope.kind === 'personal' && scope.state === 'active'
            ? oversizedWriteIndices(parsed.error)
            : undefined;
        if (indices)
          throw new AccountError(
            422,
            'Encrypted record exceeds its size limit',
            'SYNC_RECORD_TOO_LARGE',
            indices,
          );
        throw parsed.error;
      }
      return commitMutation(tx, config, scope, member, parsed.data as Mutation);
    }),
  );
  route('POST', '/scopes/:scopeId/checkpoint', (req) =>
    withScope(req, true, async (tx, scope) => {
      if (scope.state !== 'active') throw new AccountError(409);
      const value = await snapshot(tx, scope);
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_scope_checkpoints (scope_id,sequence,snapshot) VALUES (${scope.id},${scope.sequence},${JSON.stringify(value)}::jsonb) ON CONFLICT DO NOTHING`,
      );
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_scope_checkpoints WHERE scope_id=${scope.id} AND sequence NOT IN (SELECT sequence FROM ultra_scope_checkpoints WHERE scope_id=${scope.id} ORDER BY sequence DESC LIMIT 2)`,
      );
      return { sequence: scope.sequence };
    }),
  );
  route('POST', '/scopes/:scopeId/migration/finish', async (req) => {
    const body = z
      .object({ deviceId: id, count: z.number().int().nonnegative(), signature: proof })
      .strict()
      .parse(req.body);
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (scope.state === 'active') {
        if (scope.recovered_from_migration)
          throw new AccountError(
            423,
            'Setup was recovered on another device. Reconnect from Account settings in the latest Ultra Tasks app.',
            'MIGRATION_REJOIN_REQUIRED',
          );
        return { complete: true };
      }
      const account = await accountById(tx, member.account_id);
      if (
        scope.state !== 'migrating' ||
        scope.migration_device !== body.deviceId ||
        !(await verify(
          account!.bundle.signingPublicKey,
          {
            action: 'finish-migration',
            serverId: config.serverId,
            scopeId: scope.id,
            deviceId: body.deviceId,
            count: body.count,
          },
          body.signature,
        ))
      )
        throw new AccountError(409);
      const total = await one<{ count: bigint }>(
        tx,
        Prisma.sql`SELECT count(*) AS count FROM ultra_record_heads WHERE scope_id=${scope.id} AND deleted=false`,
      );
      if (Number(total?.count) !== body.count)
        throw new AccountError(409, 'Migration inventory is incomplete');
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scopes SET state='active',migration_device=NULL WHERE id=${scope.id}`,
      );
      return { complete: true };
    });
  });
  registerPersonalMigrationRecovery({ route, withScope, owner, config });
  registerPersonalReplacement({ route, withScope, owner, config });
  registerScopeRecovery({ route, withScope, owner, db, config, auth, transaction });
  if (config.privateOnly) return;

  route('POST', '/recipients', async (req) => {
    await auth(req);
    const { identifier } = z
      .object({ identifier: z.string().trim().toLowerCase().min(3).max(254) })
      .strict()
      .parse(req.body);
    const account = await accountByIdentifier(db, identifier);
    return {
      recipient: account?.verified
        ? {
            id: account.id,
            username: account.username,
            encryptionPublicKey: account.bundle.encryptionPublicKey,
            signingPublicKey: account.bundle.signingPublicKey,
          }
        : null,
    };
  });
  route('POST', '/scopes/:scopeId/invites', async (req) => {
    const body = z
      .object({
        id,
        identifier: z.string().trim().toLowerCase().min(3).max(254),
        role: z.enum(['editor', 'viewer']),
        membership: UltraMembershipSchema.nullable(),
        signature: proof,
      })
      .strict()
      .parse(req.body);
    const result = await withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (scope.kind !== 'project' || scope.state !== 'active')
        throw new AccountError(409);
      if (
        !(await verify(
          scope.owner_key,
          {
            action: 'invite',
            serverId: config.serverId,
            scopeId: scope.id,
            ...unsigned(body),
          },
          body.signature,
        ))
      )
        throw new AccountError(400);
      const recipient = await accountByIdentifier(tx, body.identifier);
      if (recipient?.id === scope.owner_id) throw new AccountError(400);
      if (!recipient?.verified && !z.email().safeParse(body.identifier).success)
        throw new AccountError(404, 'No verified account has that username');
      if (body.membership) {
        await validateMembership(tx, config, scope, body.membership);
        const a = body.membership.authorization;
        if (
          a.inviteId !== body.id ||
          a.accountId !== recipient?.id ||
          a.role !== body.role
        )
          throw new AccountError(400);
      }
      const count = await one<{ count: bigint }>(
        tx,
        Prisma.sql`SELECT count(*) AS count FROM ultra_scope_invites WHERE scope_id=${scope.id}`,
      );
      if (Number(count?.count) >= 100)
        throw new AccountError(413, 'Invitation limit reached');
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_scope_invites (id,scope_id,recipient_id,email,role,expires_at,membership,state,request) VALUES (${body.id},${scope.id},${recipient?.verified ? recipient.id : null},${recipient?.email ?? body.identifier},${body.role},${BigInt(Date.now() + 7 * 86400000)},${body.membership ? JSON.stringify(body.membership) : null}::jsonb,${body.membership ? 'pending' : 'provisioning'},${JSON.stringify(body)}::jsonb)`,
      );
      return {
        id: body.id,
        email: recipient?.email ?? body.identifier,
        state: body.membership ? 'pending' : 'provisioning',
      };
    });
    if (sendInviteMail) await sendInviteMail(result.email);
    return { id: result.id, state: result.state };
  });
  route('GET', '/invites', async (req) => {
    const session = await auth(req);
    const account = await accountById(db, session.account_id);
    const rows = await db.$queryRaw<(InviteRow & { owner_key: JsonWebKey })[]>(
      Prisma.sql`SELECT i.*,s.owner_key FROM ultra_scope_invites i JOIN ultra_scopes s ON s.id=i.scope_id WHERE (i.recipient_id=${session.account_id} OR i.email=${account!.email}) AND i.expires_at>${BigInt(Date.now())} AND i.state<>'accepted' ORDER BY i.id`,
    );
    return {
      invites: rows.map((row) => ({
        id: row.id,
        scopeId: row.scope_id,
        role: row.role,
        expiresAt: Number(row.expires_at),
        membership: row.membership,
        ownerKey: row.owner_key,
        state: row.state,
      })),
    };
  });
  route('GET', '/scopes/:scopeId/provisioning', (req) =>
    withScope(req, true, async (tx, scope, member) => {
      owner(member);
      const rows = await tx.$queryRaw<InviteRow[]>(
        Prisma.sql`SELECT * FROM ultra_scope_invites WHERE scope_id=${scope.id} AND state='provisioning' AND expires_at>${BigInt(Date.now())}`,
      );
      const pending = [];
      for (const row of rows) {
        const account = row.recipient_id
          ? await accountById(tx, row.recipient_id)
          : row.email
            ? await accountByIdentifier(tx, row.email)
            : undefined;
        if (account?.verified)
          pending.push({
            id: row.id,
            request: row.request,
            recipient: {
              id: account.id,
              username: account.username,
              encryptionPublicKey: account.bundle.encryptionPublicKey,
              signingPublicKey: account.bundle.signingPublicKey,
            },
          });
      }
      return { pending };
    }),
  );
  route('POST', '/scopes/:scopeId/provision', async (req) => {
    const body = UltraMembershipSchema.parse(req.body) as Membership;
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (scope.state !== 'active') throw new AccountError(409);
      await validateMembership(tx, config, scope, body);
      const invite = await one<InviteRow>(
        tx,
        Prisma.sql`SELECT * FROM ultra_scope_invites WHERE id=${body.authorization.inviteId} AND scope_id=${scope.id} AND state='provisioning' AND expires_at>${BigInt(Date.now())}`,
      );
      const recipient = await accountById(tx, body.authorization.accountId);
      if (
        !invite ||
        !recipient ||
        (invite.recipient_id
          ? invite.recipient_id !== recipient.id
          : invite.email !== recipient.email) ||
        body.authorization.role !== invite.role
      )
        throw new AccountError(404);
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scope_invites SET recipient_id=${recipient.id},membership=${JSON.stringify(body)}::jsonb,state='pending' WHERE id=${invite.id}`,
      );
      return { ready: true };
    });
  });
  route('POST', '/invites/:inviteId/accept', async (req) => {
    const session = await auth(req);
    const { signature } = z.object({ signature: proof }).strict().parse(req.body);
    return transaction(async (tx) => {
      await liveSession(tx, session);
      let invite = await one<InviteRow>(
        tx,
        Prisma.sql`SELECT * FROM ultra_scope_invites WHERE id=${inviteId(req)}`,
      );
      if (
        !invite ||
        invite.recipient_id !== session.account_id ||
        invite.expires_at <= BigInt(Date.now()) ||
        invite.state !== 'pending' ||
        !invite.membership
      )
        throw new AccountError(404, 'Invitation is unavailable or awaiting the owner');
      const scope = await one<ScopeRow>(
        tx,
        Prisma.sql`SELECT * FROM ultra_scopes WHERE id=${invite.scope_id} FOR UPDATE`,
      );
      invite = await one<InviteRow>(
        tx,
        Prisma.sql`SELECT * FROM ultra_scope_invites WHERE id=${inviteId(req)}`,
      );
      if (
        !invite ||
        invite.recipient_id !== session.account_id ||
        invite.state !== 'pending' ||
        !invite.membership ||
        invite.expires_at <= BigInt(Date.now())
      )
        throw new AccountError(404);
      if (
        !scope ||
        scope.state !== 'active' ||
        invite.membership.authorization.epoch !== scope.epoch
      )
        throw new AccountError(409, 'Project key changed; waiting for the owner');
      await validateMembership(tx, config, scope, invite.membership);
      const account = await accountById(tx, session.account_id);
      if (
        !(await verify(
          account!.bundle.signingPublicKey,
          {
            action: 'accept',
            serverId: config.serverId,
            inviteId: invite.id,
            membership: invite.membership,
          },
          signature,
        ))
      )
        throw new AccountError(400);
      if (
        await one(
          tx,
          Prisma.sql`SELECT account_id FROM ultra_scope_members WHERE scope_id=${scope.id} AND account_id=${session.account_id}`,
        )
      )
        throw new AccountError(409, 'Already a member');
      const total = await one<{ count: bigint }>(
        tx,
        Prisma.sql`SELECT count(*) AS count FROM ultra_scope_members WHERE scope_id=${scope.id}`,
      );
      if (Number(total?.count) >= 50)
        throw new AccountError(413, 'Project member limit reached');
      await putMember(tx, scope.id, invite.membership);
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scope_invites SET state='accepted' WHERE id=${invite.id}`,
      );
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scopes SET control_version=control_version+1 WHERE id=${scope.id}`,
      );
      return { accepted: true };
    });
  });
  route('POST', '/scopes/:scopeId/invites/revoke', async (req) => {
    const body = z.object({ inviteId: id, signature: proof }).strict().parse(req.body);
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (
        !(await verify(
          scope.owner_key,
          {
            action: 'revoke-invite',
            serverId: config.serverId,
            scopeId: scope.id,
            inviteId: body.inviteId,
          },
          body.signature,
        ))
      )
        throw new AccountError(400);
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_scope_invites WHERE id=${body.inviteId} AND scope_id=${scope.id}`,
      );
      return { revoked: true };
    });
  });
};
