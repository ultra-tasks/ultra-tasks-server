import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import {
  canonical,
  verify,
  type Membership,
  type Mutation,
} from '@ultra-tasks/account-crypto';
import { UltraMembershipSchema, UltraMutationSchema } from '@sp/shared-schema';
import { AccountError, authenticateAccount, type UltraConfig } from './security';
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
  unsigned,
  validateMembership,
  validateMutation,
  type ScopeRow,
  type MemberRow,
  type HeadRow,
} from './scope-store';

interface Options {
  db: UltraDb;
  transaction: UltraTransaction;
  config: UltraConfig;
  sendInviteMail?: (email: string) => Promise<boolean>;
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

export const ultraScopeRoutes = async (
  app: FastifyInstance,
  { db, transaction, config, sendInviteMail }: Options,
): Promise<void> => {
  const auth = (req: FastifyRequest) =>
    authenticateAccount(db, config, req.headers.authorization);
  const route = (
    method: 'GET' | 'POST',
    url: string,
    run: (req: FastifyRequest) => Promise<unknown>,
  ) =>
    app.route({
      method,
      url,
      bodyLimit: 8 * 1024 * 1024,
      config: { rateLimit: { max: 600, timeWindow: '15 minutes' } },
      handler: async (req, reply) => {
        reply
          .header('Cache-Control', 'no-store')
          .header('Referrer-Policy', 'no-referrer');
        try {
          return await run(req);
        } catch (error) {
          if (error instanceof ZodError)
            return reply.code(400).send({ error: 'Invalid encrypted sync request' });
          if (error instanceof AccountError)
            return reply.code(error.statusCode).send({ error: error.message });
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
      return { scopes: await Promise.all(rows.map((row) => scopeInfo(tx, row))) };
    });
  });
  route('POST', '/scopes', async (req) => {
    const body = z
      .object({
        kind: z.enum(['personal', 'project']),
        membership: UltraMembershipSchema,
        deviceId: id,
        migrating: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    const session = await auth(req);
    return transaction(async (tx) => {
      await liveSession(tx, session);
      const account = await accountById(tx, session.account_id);
      if (!account?.verified) throw new AccountError(403);
      if (body.kind === 'personal') {
        // Serialize first-device creation on the immutable account row.
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM ultra_accounts WHERE id=${session.account_id} FOR UPDATE`,
        );
        const previous = await one<ScopeRow>(
          tx,
          Prisma.sql`SELECT * FROM ultra_scopes WHERE owner_id=${session.account_id} AND kind='personal'`,
        );
        if (previous) return scopeInfo(tx, previous);
      }
      const count = await one<{ count: bigint }>(
        tx,
        Prisma.sql`SELECT count(*) AS count FROM ultra_scope_members WHERE account_id=${session.account_id}`,
      );
      if (Number(count?.count) >= 101)
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
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_scopes (id,kind,owner_id,owner_key,state,migration_device) VALUES (${scope.id},${scope.kind},${scope.owner_id},${JSON.stringify(scope.owner_key)}::jsonb,${scope.state},${scope.migration_device})`,
      );
      await putMember(tx, scope.id, body.membership);
      return scopeInfo(tx, scope);
    });
  });
  route('GET', '/scopes/:scopeId/snapshot', (req) =>
    withScope(req, false, (tx, scope) => snapshot(tx, scope)),
  );
  route('GET', '/scopes/:scopeId/changes', (req) =>
    withScope(req, false, async (tx, scope) => {
      const { after, generation } = z
        .object({
          after: z.coerce.number().int().nonnegative(),
          generation: z.coerce.number().int().positive(),
        })
        .parse(req.query);
      if (after === scope.sequence && generation === scope.generation)
        return { scope: await scopeInfo(tx, scope), unchanged: true };
      return snapshot(tx, scope);
    }),
  );
  route('POST', '/scopes/:scopeId/transactions', async (req) => {
    const mutation = UltraMutationSchema.parse(req.body) as Mutation;
    return withScope(req, true, (tx, scope, member) =>
      commitMutation(tx, config, scope, member, mutation),
    );
  });
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
      if (scope.state === 'active') return { complete: true };
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
  route('POST', '/scopes/:scopeId/rotation/start', async (req) => {
    const body = z
      .object({
        id,
        removeId: id,
        controlVersion: z.number().int().positive(),
        members: z.array(UltraMembershipSchema).min(1).max(50),
        signature: proof,
      })
      .strict()
      .parse(req.body);
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (scope.kind !== 'project' || body.removeId === scope.owner_id)
        throw new AccountError(400, 'The owner cannot be removed');
      if (scope.state === 'rotating' && scope.rotation?.id === body.id)
        return scopeInfo(tx, scope);
      if (
        scope.state !== 'active' ||
        scope.control_version !== body.controlVersion ||
        !(await verify(
          scope.owner_key,
          {
            action: 'rotate',
            serverId: config.serverId,
            scopeId: scope.id,
            ...unsigned(body),
          },
          body.signature,
        ))
      )
        throw new AccountError(409);
      const previous = await tx.$queryRaw<MemberRow[]>(
        Prisma.sql`SELECT * FROM ultra_scope_members WHERE scope_id=${scope.id}`,
      );
      const remaining = previous.filter((row) => row.account_id !== body.removeId);
      if (
        remaining.length === previous.length ||
        canonical(remaining.map((row) => row.account_id).sort()) !==
          canonical(body.members.map((row) => row.authorization.accountId).sort())
      )
        throw new AccountError(400);
      for (const next of body.members) {
        await validateMembership(tx, config, { ...scope, epoch: scope.epoch + 1 }, next);
        if (
          next.authorization.role !==
          remaining.find((row) => row.account_id === next.authorization.accountId)?.role
        )
          throw new AccountError(400);
      }
      const rotation = { id: body.id, members: body.members };
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_scope_members WHERE scope_id=${scope.id} AND account_id=${body.removeId}`,
      );
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scopes SET state='rotating',control_version=control_version+1,rotation=${JSON.stringify(rotation)}::jsonb WHERE id=${scope.id}`,
      );
      // A pending grant uses the retired epoch; require owner provisioning again.
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scope_invites SET membership=NULL,state='provisioning' WHERE scope_id=${scope.id} AND state<>'accepted'`,
      );
      return scopeInfo(tx, {
        ...scope,
        state: 'rotating',
        control_version: scope.control_version + 1,
        rotation,
      });
    });
  });
  route('POST', '/scopes/:scopeId/rotation/stage', async (req) => {
    const mutation = UltraMutationSchema.parse(req.body) as Mutation;
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (scope.state !== 'rotating') throw new AccountError(409);
      await validateMutation(config, scope, member, mutation, true);
      for (const write of mutation.writes) {
        const h = write.record.header;
        const old = await one<HeadRow>(
          tx,
          Prisma.sql`SELECT * FROM ultra_record_heads WHERE scope_id=${scope.id} AND entity_id=${h.entityId}`,
        );
        if (
          !old ||
          h.baseRevision !== old.revision ||
          old.deleted !== write.deleted ||
          old.write.record.header.entityType !== h.entityType
        )
          throw new AccountError(
            409,
            'Rotation must preserve the complete record inventory',
          );
        await tx.$executeRaw(
          Prisma.sql`INSERT INTO ultra_rotation_heads (scope_id,entity_id,write,manifest) VALUES (${scope.id},${h.entityId},${JSON.stringify(write)}::jsonb,${JSON.stringify(mutation)}::jsonb) ON CONFLICT (scope_id,entity_id) DO UPDATE SET write=excluded.write,manifest=excluded.manifest`,
        );
      }
      return { staged: true };
    });
  });
  route('POST', '/scopes/:scopeId/rotation/finish', async (req) => {
    const body = z.object({ id, signature: proof }).strict().parse(req.body);
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (
        scope.state !== 'rotating' ||
        scope.rotation?.id !== body.id ||
        !(await verify(
          scope.owner_key,
          {
            action: 'finish-rotation',
            serverId: config.serverId,
            scopeId: scope.id,
            id: body.id,
          },
          body.signature,
        ))
      )
        throw new AccountError(409);
      const oldCount = await one<{ count: bigint }>(
        tx,
        Prisma.sql`SELECT count(*) AS count FROM ultra_record_heads WHERE scope_id=${scope.id}`,
      );
      const staged = await tx.$queryRaw<
        { entity_id: string; write: HeadRow['write']; manifest: Mutation }[]
      >(
        Prisma.sql`SELECT * FROM ultra_rotation_heads WHERE scope_id=${scope.id} ORDER BY entity_id`,
      );
      if (staged.length !== Number(oldCount?.count))
        throw new AccountError(409, 'Project key update is incomplete');
      let sequence = scope.sequence;
      const manifests = new Map(
        staged.map((row) => [row.manifest.mutationId, row.manifest]),
      );
      for (const mutation of manifests.values()) {
        await tx.$executeRaw(
          Prisma.sql`INSERT INTO ultra_scope_mutations (id,scope_id,sequence,manifest,created_at) VALUES (${mutation.mutationId},${scope.id},${++sequence},${JSON.stringify(mutation)}::jsonb,${BigInt(Date.now())})`,
        );
      }
      for (const row of staged) {
        await tx.$executeRaw(
          Prisma.sql`UPDATE ultra_record_heads SET revision=${row.write.record.header.revision},mutation_id=${row.manifest.mutationId},write=${JSON.stringify(row.write)}::jsonb,bytes=${Buffer.byteLength(JSON.stringify(row.write))} WHERE scope_id=${scope.id} AND entity_id=${row.entity_id}`,
        );
      }
      for (const membership of scope.rotation.members)
        await putMember(tx, scope.id, membership);
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scopes SET state='active',epoch=epoch+1,generation=generation+1,rotation=NULL,sequence=${sequence} WHERE id=${scope.id}`,
      );
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_rotation_heads WHERE scope_id=${scope.id}`,
      );
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_scope_checkpoints WHERE scope_id=${scope.id}`,
      );
      return { complete: true };
    });
  });
};
