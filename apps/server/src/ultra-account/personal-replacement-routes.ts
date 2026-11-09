import type { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { fingerprint, verify, type Mutation } from '@ultra-tasks/account-crypto';
import { UltraMutationSchema } from '@ultra-tasks/sync-contract';
import { AccountError, DAY, type UltraConfig } from './security';
import { one, type UltraDb } from './store';
import {
  snapshot,
  unsigned,
  validateMutation,
  type MemberRow,
  type ScopeRow,
} from './scope-store';

const id = z.string().uuid();
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const maxBytes = 32 * 1024 * 1024;
interface Replacement {
  id: string;
  device_id: string;
  sequence: number;
  generation: number;
  control_version: number;
  record_count: number;
  batches: string[];
  committed_sequence: number | null;
}
interface Context {
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
  config: UltraConfig;
}

const replacementFor = async (
  tx: UltraDb,
  scope: ScopeRow,
  replacementId: string,
): Promise<Replacement> => {
  const row = await one<Replacement>(
    tx,
    Prisma.sql`SELECT * FROM ultra_personal_replacements WHERE scope_id=${scope.id}`,
  );
  if (
    !row ||
    row.id !== replacementId ||
    row.committed_sequence !== null ||
    scope.kind !== 'personal' ||
    scope.state !== 'active' ||
    scope.sequence !== row.sequence ||
    scope.generation !== row.generation ||
    scope.control_version !== row.control_version
  )
    throw new AccountError(
      409,
      'Account data changed while switching providers; review the choice and try again',
    );
  return row;
};

/** Stages a signed encrypted inventory separately; readers see one atomic generation change. */
export const registerPersonalReplacement = ({
  route,
  withScope,
  owner,
  config,
}: Context): void => {
  route('POST', '/scopes/:scopeId/replacement/start', async (req) => {
    const body = z
      .object({
        action: z.literal('start-personal-replacement'),
        serverId: id,
        scopeId: id,
        id,
        deviceId: id,
        sequence: z.number().int().nonnegative(),
        generation: z.number().int().positive(),
        controlVersion: z.number().int().positive(),
        count: z.number().int().min(1).max(50000),
        batches: z.array(hash).min(1).max(500),
        signature,
      })
      .strict()
      .parse(req.body);
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (
        scope.kind !== 'personal' ||
        scope.state !== 'active' ||
        body.serverId !== config.serverId ||
        body.scopeId !== scope.id ||
        body.sequence !== scope.sequence ||
        body.generation !== scope.generation ||
        body.controlVersion !== scope.control_version ||
        new Set(body.batches).size !== body.batches.length ||
        !(await verify(scope.owner_key, unsigned(body), body.signature))
      )
        throw new AccountError(
          409,
          'Account data changed or replacement authorization is invalid',
        );
      const existing = await one<Replacement>(
        tx,
        Prisma.sql`SELECT * FROM ultra_personal_replacements WHERE scope_id=${scope.id}`,
      );
      if (existing?.id === body.id) {
        if (
          existing.device_id !== body.deviceId ||
          existing.sequence !== body.sequence ||
          existing.generation !== body.generation ||
          existing.control_version !== body.controlVersion ||
          existing.record_count !== body.count ||
          JSON.stringify(existing.batches) !== JSON.stringify(body.batches)
        )
          throw new AccountError(409);
        return { started: true };
      }
      // A fresh owner-signed start cancels any abandoned stage without touching live data.
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_personal_replacements WHERE scope_id=${scope.id}`,
      );
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_personal_replacements (scope_id,id,device_id,sequence,generation,control_version,record_count,batches) VALUES (${scope.id},${body.id},${body.deviceId},${body.sequence},${body.generation},${body.controlVersion},${body.count},${JSON.stringify(body.batches)}::jsonb)`,
      );
      return { started: true };
    });
  });

  route('POST', '/scopes/:scopeId/replacement/stage', async (req) => {
    const body = z.object({ id, mutation: UltraMutationSchema }).strict().parse(req.body);
    const mutation = body.mutation as Mutation;
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      const batchHash = await fingerprint(mutation);
      const previous = await one<Replacement>(
        tx,
        Prisma.sql`SELECT * FROM ultra_personal_replacements WHERE scope_id=${scope.id}`,
      );
      if (
        previous?.id === body.id &&
        previous.committed_sequence !== null &&
        previous.device_id === mutation.deviceId &&
        previous.batches.includes(batchHash)
      )
        return { staged: true };
      const job = await replacementFor(tx, scope, body.id);
      if (mutation.deviceId !== job.device_id || !job.batches.includes(batchHash))
        throw new AccountError(409, 'Replacement batch was not authorized');
      await validateMutation(
        config,
        { ...scope, generation: scope.generation + 1 },
        member,
        mutation,
      );
      if (
        mutation.writes.some(
          ({ record, restore }) =>
            restore ||
            record.header.baseRevision !== 0 ||
            record.header.revision !== 1 ||
            !record.header.entityType.startsWith('personal.'),
        )
      )
        throw new AccountError(400, 'Invalid replacement record');
      const existing = await one(
        tx,
        Prisma.sql`SELECT digest FROM ultra_personal_replacement_batches WHERE scope_id=${scope.id} AND digest=${batchHash}`,
      );
      if (existing) return { staged: true };
      const total = await one<{ bytes: bigint | null }>(
        tx,
        Prisma.sql`SELECT sum(octet_length(manifest::text)) AS bytes FROM ultra_personal_replacement_batches WHERE scope_id=${scope.id}`,
      );
      if (
        Number(total?.bytes ?? 0) + Buffer.byteLength(JSON.stringify(mutation)) >
        maxBytes
      )
        throw new AccountError(413, 'Encrypted replacement exceeds the account quota');
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_personal_replacement_batches (scope_id,digest,manifest) VALUES (${scope.id},${batchHash},${JSON.stringify(mutation)}::jsonb)`,
      );
      return { staged: true };
    });
  });

  route('POST', '/scopes/:scopeId/replacement/finish', async (req) => {
    const body = z
      .object({
        action: z.literal('finish-personal-replacement'),
        serverId: id,
        scopeId: id,
        id,
        signature,
      })
      .strict()
      .parse(req.body);
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (
        body.serverId !== config.serverId ||
        body.scopeId !== scope.id ||
        !(await verify(scope.owner_key, unsigned(body), body.signature))
      )
        throw new AccountError(403, 'Invalid replacement authorization');
      const previous = await one<Replacement>(
        tx,
        Prisma.sql`SELECT * FROM ultra_personal_replacements WHERE scope_id=${scope.id}`,
      );
      if (previous?.id === body.id && previous.committed_sequence !== null)
        return { complete: true };
      const job = await replacementFor(tx, scope, body.id);
      const staged = await tx.$queryRaw<{ digest: string; manifest: Mutation }[]>(
        Prisma.sql`SELECT digest,manifest FROM ultra_personal_replacement_batches WHERE scope_id=${scope.id}`,
      );
      if (
        staged.length !== job.batches.length ||
        staged.some((row) => !job.batches.includes(row.digest))
      )
        throw new AccountError(409, 'Encrypted replacement is incomplete');
      const entityTypes = new Map<string, string>();
      for (const { manifest } of staged)
        for (const { record } of manifest.writes) {
          if (entityTypes.has(record.header.entityId))
            throw new AccountError(409, 'Duplicate replacement record');
          entityTypes.set(record.header.entityId, record.header.entityType);
        }
      if (entityTypes.size !== job.record_count)
        throw new AccountError(409, 'Encrypted replacement is incomplete');
      // Existing clients rebase offline edits against authenticated tombstones.
      // Omitting even an old deleted head would make a stale edit look like a
      // live record with no value, so require every previous id in the inventory.
      const previousHeads = await tx.$queryRaw<
        { entity_id: string; entity_type: string }[]
      >(
        Prisma.sql`SELECT entity_id,write->'record'->'header'->>'entityType' AS entity_type FROM ultra_record_heads WHERE scope_id=${scope.id}`,
      );
      if (previousHeads.some(({ entity_id }) => !entityTypes.has(entity_id)))
        throw new AccountError(409, 'Replacement is missing prior record tombstones');
      if (
        previousHeads.some(
          ({ entity_id, entity_type }) => entityTypes.get(entity_id) !== entity_type,
        )
      )
        throw new AccountError(409, 'Replacement changed a prior record type');
      // Replacement cannot bypass the same bounded history used by ordinary writes.
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_scope_mutations m WHERE m.scope_id=${scope.id} AND m.created_at<${BigInt(Date.now() - 30 * DAY)} AND NOT EXISTS (SELECT 1 FROM ultra_record_heads h WHERE h.scope_id=m.scope_id AND h.mutation_id=m.id)`,
      );
      const history = await one<{ bytes: bigint | null }>(
        tx,
        Prisma.sql`SELECT sum(octet_length(manifest::text)) AS bytes FROM ultra_scope_mutations WHERE scope_id=${scope.id}`,
      );
      const incomingBytes = staged.reduce(
        (total, row) => total + Buffer.byteLength(JSON.stringify(row.manifest)),
        0,
      );
      if (Number(history?.bytes ?? 0) + incomingBytes > 128 * 1024 * 1024)
        throw new AccountError(
          413,
          'Encrypted history quota reached; local changes are retained',
        );
      const old = await snapshot(tx, scope);
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ultra_scope_checkpoints (scope_id,sequence,snapshot) VALUES (${scope.id},${scope.sequence},${JSON.stringify(old)}::jsonb) ON CONFLICT DO NOTHING`,
      );
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_record_heads WHERE scope_id=${scope.id}`,
      );
      let sequence = scope.sequence;
      for (const { manifest } of staged) {
        await tx.$executeRaw(
          Prisma.sql`INSERT INTO ultra_scope_mutations (id,scope_id,sequence,manifest,created_at) VALUES (${manifest.mutationId},${scope.id},${++sequence},${JSON.stringify(manifest)}::jsonb,${BigInt(Date.now())})`,
        );
        const rows = manifest.writes.map((write) => {
          const h = write.record.header;
          return Prisma.sql`(${scope.id},${h.entityId},${h.revision},${manifest.mutationId},${write.deleted},${JSON.stringify(write)}::jsonb,${Buffer.byteLength(JSON.stringify(write))})`;
        });
        await tx.$executeRaw(
          Prisma.sql`INSERT INTO ultra_record_heads (scope_id,entity_id,revision,mutation_id,deleted,write,bytes) VALUES ${Prisma.join(rows)}`,
        );
      }
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scopes SET generation=generation+1,sequence=${sequence} WHERE id=${scope.id}`,
      );
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_personal_replacements SET committed_sequence=${sequence} WHERE scope_id=${scope.id}`,
      );
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_personal_replacement_batches WHERE scope_id=${scope.id}`,
      );
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM ultra_scope_checkpoints WHERE scope_id=${scope.id} AND sequence NOT IN (SELECT sequence FROM ultra_scope_checkpoints WHERE scope_id=${scope.id} ORDER BY sequence DESC LIMIT 2)`,
      );
      return { complete: true };
    });
  });
};
