import type { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  canonical,
  verify,
  verifyOwnershipAcceptance,
  type Membership,
  type Mutation,
  type OwnershipOffer,
  type OwnershipAcceptance,
  type ScopeRotation,
  type ScopeSnapshot,
} from '@ultra-tasks/account-crypto';
import {
  UltraMembershipSchema,
  UltraMutationSchema,
  UltraOwnershipOfferSchema,
  UltraOwnershipAcceptanceSchema,
} from '@sp/shared-schema';
import { AccountError, DAY, type UltraConfig } from './security';
import {
  accountById,
  one,
  type UltraDb,
  type UltraTransaction,
  type SessionRow,
} from './store';
import {
  liveSession,
  lockScope,
  putMember,
  scopeInfo,
  unsigned,
  validateMembership,
  validateMutation,
  type ScopeRow,
  type MemberRow,
  type HeadRow,
} from './scope-store';

const id = z.string().uuid();
const proof = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
interface RecoveryContext {
  db: UltraDb;
  config: UltraConfig;
  transaction: UltraTransaction;
  auth: (req: FastifyRequest) => Promise<SessionRow>;
  route: (
    method: 'GET' | 'POST',
    url: string,
    run: (req: FastifyRequest) => Promise<unknown>,
  ) => unknown;
  withScope: <T>(
    req: FastifyRequest,
    write: boolean,
    run: (tx: UltraDb, scope: ScopeRow, member: MemberRow) => Promise<T>,
  ) => Promise<T>;
  owner: (member: MemberRow) => void;
}
const nextOwner = (scope: ScopeRow): ScopeRow =>
  scope.rotation?.transfer
    ? {
        ...scope,
        owner_id: scope.rotation.transfer.offer.recipientId,
        owner_key: scope.rotation.transfer.offer.recipientSigningKey,
      }
    : scope;
const controller = (scope: ScopeRow, member: MemberRow): void => {
  if (member.account_id !== (scope.rotation?.controllerId ?? scope.owner_id))
    throw new AccountError(403);
};
const invalidateInvites = (tx: UltraDb, scopeId: string) =>
  tx.$executeRaw(
    Prisma.sql`UPDATE ultra_scope_invites SET membership=NULL,state='provisioning' WHERE scope_id=${scopeId} AND state<>'accepted'`,
  );
const freeze = async (
  tx: UltraDb,
  scope: ScopeRow,
  rotation: ScopeRotation,
): Promise<ScopeRow> => {
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_rotation_heads WHERE scope_id=${scope.id}`,
  );
  await tx.$executeRaw(
    Prisma.sql`UPDATE ultra_scopes SET state='rotating',control_version=control_version+1,rotation=${JSON.stringify(rotation)}::jsonb WHERE id=${scope.id}`,
  );
  await invalidateInvites(tx, scope.id);
  return {
    ...scope,
    state: 'rotating',
    control_version: scope.control_version + 1,
    rotation,
  };
};
const validateNextMembers = async (
  tx: UltraDb,
  config: UltraConfig,
  scope: ScopeRow,
  members: Membership[],
  transfer = false,
): Promise<void> => {
  const rows = await tx.$queryRaw<MemberRow[]>(
    Prisma.sql`SELECT * FROM ultra_scope_members WHERE scope_id=${scope.id}`,
  );
  if (
    canonical(rows.map((row) => row.account_id).sort()) !==
    canonical(members.map((m) => m.authorization.accountId).sort())
  )
    throw new AccountError(400, 'The complete membership is required');
  for (const member of members) {
    await validateMembership(
      tx,
      config,
      { ...nextOwner(scope), epoch: scope.epoch + 1 },
      member,
    );
    const old = rows.find((row) => row.account_id === member.authorization.accountId)!;
    const expected = transfer
      ? old.account_id === nextOwner(scope).owner_id
        ? 'owner'
        : old.role === 'owner'
          ? 'editor'
          : old.role
      : old.role;
    if (member.authorization.role !== expected)
      throw new AccountError(400, 'Invalid membership role');
  }
};

export const registerScopeRecovery = ({
  route,
  withScope,
  owner,
  db,
  config,
  auth,
  transaction,
}: RecoveryContext): void => {
  route('POST', '/scopes/:scopeId/ownership/offer', async (req) => {
    const offer = UltraOwnershipOfferSchema.parse(req.body) as OwnershipOffer;
    return withScope(req, false, async (tx, scope, member) => {
      owner(member);
      const recipient = await one<MemberRow>(
        tx,
        Prisma.sql`SELECT * FROM ultra_scope_members WHERE scope_id=${scope.id} AND account_id=${offer.recipientId}`,
      );
      const a = recipient?.membership.authorization;
      if (
        scope.kind !== 'project' ||
        scope.state !== 'active' ||
        !a ||
        offer.previousOwnerId !== scope.owner_id ||
        canonical(offer.previousOwnerKey) !== canonical(scope.owner_key) ||
        offer.recipientId === scope.owner_id ||
        offer.serverId !== config.serverId ||
        offer.scopeId !== scope.id ||
        offer.epoch !== scope.epoch ||
        offer.controlVersion !== scope.control_version ||
        offer.expiresAt <= Date.now() ||
        offer.expiresAt > Date.now() + 7 * DAY ||
        canonical(a.signingPublicKey) !== canonical(offer.recipientSigningKey) ||
        canonical(a.encryptionPublicKey) !== canonical(offer.recipientEncryptionKey) ||
        (scope.ownership_chain?.length ?? 0) >= 100 ||
        !(await verify(scope.owner_key, unsigned(offer), offer.signature))
      )
        throw new AccountError(409, 'Ownership offer is invalid or the project changed');
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_scope_transfers WHERE scope_id=${scope.id}`,
      );
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_scope_transfers(id,scope_id,recipient_id,epoch,control_version,expires_at,offer) VALUES (${offer.id},${scope.id},${offer.recipientId},${scope.epoch},${scope.control_version},${BigInt(offer.expiresAt)},${JSON.stringify(offer)}::jsonb)`,
      );
      return { offered: true };
    });
  });
  route('GET', '/ownership/offers', async (req) => {
    const session = await auth(req);
    return transaction(async (tx) => {
      await liveSession(tx, session);
      const rows = await tx.$queryRaw<{ offer: OwnershipOffer }[]>(
        Prisma.sql`SELECT t.offer FROM ultra_scope_transfers t JOIN ultra_scopes s ON s.id=t.scope_id JOIN ultra_scope_members m ON m.scope_id=s.id AND m.account_id=t.recipient_id WHERE t.recipient_id=${session.account_id} AND t.expires_at>${BigInt(Date.now())} AND s.state='active' AND t.epoch=s.epoch AND t.control_version=s.control_version ORDER BY t.id`,
      );
      return { offers: rows.map((row) => row.offer) };
    });
  });
  route('POST', '/scopes/:scopeId/ownership/accept', async (req) => {
    const acceptance = UltraOwnershipAcceptanceSchema.parse(
      req.body,
    ) as OwnershipAcceptance;
    return withScope(req, false, async (tx, scope, member) => {
      if (
        scope.state === 'rotating' &&
        scope.rotation?.id === acceptance.offer.id &&
        canonical(scope.rotation.transfer) === canonical(acceptance)
      )
        return scopeInfo(tx, scope);
      const row = await one<{ offer: OwnershipOffer }>(
        tx,
        Prisma.sql`SELECT offer FROM ultra_scope_transfers WHERE id=${acceptance.offer.id} AND scope_id=${scope.id} AND recipient_id=${member.account_id} AND epoch=${scope.epoch} AND control_version=${scope.control_version} AND expires_at>${BigInt(Date.now())}`,
      );
      if (
        !row ||
        scope.state !== 'active' ||
        canonical(row.offer) !== canonical(acceptance.offer) ||
        !(await verifyOwnershipAcceptance(acceptance))
      )
        throw new AccountError(409, 'Ownership offer expired or the project changed');
      const rotation: ScopeRotation = {
        id: acceptance.offer.id,
        kind: 'transfer',
        controllerId: member.account_id,
        members: acceptance.members,
        transfer: acceptance,
      };
      const next = { ...scope, rotation };
      await validateNextMembers(tx, config, next, acceptance.members, true);
      return scopeInfo(tx, await freeze(tx, scope, rotation));
    });
  });
  route('GET', '/scopes/:scopeId/checkpoints', (req) =>
    withScope(req, false, async (tx, scope, member) => {
      owner(member);
      return {
        checkpoints: await tx.$queryRaw<{ sequence: number }[]>(
          Prisma.sql`SELECT sequence FROM ultra_scope_checkpoints WHERE scope_id=${scope.id} ORDER BY sequence DESC`,
        ),
      };
    }),
  );
  route('POST', '/scopes/:scopeId/restore/start', async (req) => {
    const body = z
      .object({
        id,
        sequence: z.number().int().nonnegative(),
        controlVersion: z.number().int().positive(),
        members: z.array(UltraMembershipSchema).min(1).max(50),
        signature: proof,
      })
      .strict()
      .parse(req.body);
    return withScope(req, false, async (tx, scope, member) => {
      owner(member);
      if (scope.state === 'rotating' && scope.rotation?.id === body.id)
        return scopeInfo(tx, scope);
      if (
        scope.kind !== 'project' ||
        scope.state !== 'active' ||
        scope.control_version !== body.controlVersion ||
        !(await verify(
          scope.owner_key,
          {
            action: 'restore-project',
            serverId: config.serverId,
            scopeId: scope.id,
            ...unsigned(body),
          },
          body.signature,
        ))
      )
        throw new AccountError(409);
      const checkpoint = await one<{ snapshot: ScopeSnapshot }>(
        tx,
        Prisma.sql`SELECT snapshot FROM ultra_scope_checkpoints WHERE scope_id=${scope.id} AND sequence=${body.sequence}`,
      );
      if (
        !checkpoint ||
        checkpoint.snapshot.scope.epoch !== scope.epoch ||
        checkpoint.snapshot.scope.ownerId !== scope.owner_id
      )
        throw new AccountError(409, 'Checkpoint is unavailable in the current key epoch');
      await validateNextMembers(tx, config, scope, body.members);
      return scopeInfo(
        tx,
        await freeze(tx, scope, {
          id: body.id,
          kind: 'restore',
          controllerId: scope.owner_id,
          members: body.members,
          checkpointSequence: body.sequence,
        }),
      );
    });
  });
  route('GET', '/scopes/:scopeId/restore/source', (req) =>
    withScope(req, false, async (tx, scope, member) => {
      owner(member);
      if (scope.state !== 'rotating' || scope.rotation?.kind !== 'restore')
        throw new AccountError(409);
      const row = await one<{ snapshot: ScopeSnapshot }>(
        tx,
        Prisma.sql`SELECT snapshot FROM ultra_scope_checkpoints WHERE scope_id=${scope.id} AND sequence=${scope.rotation.checkpointSequence}`,
      );
      if (!row) throw new AccountError(409, 'Restore checkpoint is unavailable');
      return row.snapshot;
    }),
  );
  route('POST', '/scopes/:scopeId/delete', async (req) => {
    const body = z
      .object({ controlVersion: z.number().int().positive(), signature: proof })
      .strict()
      .parse(req.body);
    return withScope(req, false, async (tx, scope, member) => {
      owner(member);
      if (
        scope.kind !== 'project' ||
        body.controlVersion !== scope.control_version ||
        !(await verify(
          scope.owner_key,
          {
            action: 'delete-project',
            serverId: config.serverId,
            scopeId: scope.id,
            controlVersion: body.controlVersion,
          },
          body.signature,
        ))
      )
        throw new AccountError(409);
      await tx.$executeRaw(Prisma.sql`DELETE FROM ultra_scopes WHERE id=${scope.id}`);
      return { deleted: true };
    });
  });
  route('POST', '/scopes/:scopeId/rotation/provision', async (req) => {
    const body = z
      .object({
        id,
        controlVersion: z.number().int().positive(),
        members: z.array(UltraMembershipSchema).min(1).max(50),
        signature: proof,
      })
      .strict()
      .parse(req.body);
    return withScope(req, false, async (tx, scope, member) => {
      owner(member);
      if (
        scope.state !== 'rotating' ||
        scope.rotation?.kind !== 'member-left' ||
        body.id !== scope.rotation.id ||
        body.controlVersion !== scope.control_version ||
        !(await verify(
          scope.owner_key,
          {
            action: 'provision-rotation',
            serverId: config.serverId,
            scopeId: scope.id,
            ...unsigned(body),
          },
          body.signature,
        ))
      )
        throw new AccountError(409);
      if (scope.rotation.members.length) return scopeInfo(tx, scope);
      await validateNextMembers(tx, config, scope, body.members);
      const rotation = { ...scope.rotation, members: body.members };
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scopes SET rotation=${JSON.stringify(rotation)}::jsonb WHERE id=${scope.id}`,
      );
      return scopeInfo(tx, { ...scope, rotation });
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
      const rotation: ScopeRotation = {
        id: body.id,
        kind: 'remove',
        controllerId: scope.owner_id,
        members: body.members,
      };
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
    return withScope(req, false, async (tx, scope, member) => {
      controller(scope, member);
      if (scope.state !== 'rotating') throw new AccountError(409);
      const next = scope.rotation?.members.find(
        (m) => m.authorization.accountId === member.account_id,
      );
      if (!next) throw new AccountError(409, 'Project key grants are not prepared');
      await validateMutation(
        config,
        nextOwner(scope),
        { ...member, role: next.authorization.role },
        mutation,
        true,
      );
      for (const write of mutation.writes) {
        const h = write.record.header;
        const old = await one<HeadRow>(
          tx,
          Prisma.sql`SELECT * FROM ultra_record_heads WHERE scope_id=${scope.id} AND entity_id=${h.entityId}`,
        );
        if (
          !old ||
          h.baseRevision !== old.revision ||
          (scope.rotation?.kind !== 'restore' && old.deleted !== write.deleted) ||
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
    return withScope(req, false, async (tx, scope, member) => {
      controller(scope, member);
      if (
        scope.state !== 'rotating' ||
        scope.rotation?.id !== body.id ||
        !(await verify(
          nextOwner(scope).owner_key,
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
          Prisma.sql`UPDATE ultra_record_heads SET revision=${row.write.record.header.revision},deleted=${row.write.deleted},mutation_id=${row.manifest.mutationId},write=${JSON.stringify(row.write)}::jsonb,bytes=${Buffer.byteLength(JSON.stringify(row.write))} WHERE scope_id=${scope.id} AND entity_id=${row.entity_id}`,
        );
      }
      for (const membership of scope.rotation.members)
        await putMember(tx, scope.id, membership);
      const next = nextOwner(scope);
      const chain = [
        ...(scope.ownership_chain ?? []),
        ...(scope.rotation.transfer ? [scope.rotation.transfer] : []),
      ];
      // Even an empty project changes its cursor when a generation commits.
      sequence = Math.max(sequence, scope.sequence + 1);
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scopes SET state='active',owner_id=${next.owner_id},owner_key=${JSON.stringify(next.owner_key)}::jsonb,ownership_chain=${JSON.stringify(chain)}::jsonb,epoch=epoch+1,generation=generation+1,rotation=NULL,sequence=${sequence} WHERE id=${scope.id}`,
      );
      if (scope.rotation.transfer)
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM ultra_scope_invites WHERE scope_id=${scope.id} AND state<>'accepted'`,
        );
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_scope_transfers WHERE scope_id=${scope.id}`,
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
