import { Prisma } from '@prisma/client';
import {
  canonical,
  verify,
  type Membership,
  type Mutation,
  type ScopeInfo,
  type ScopeSnapshot,
  type SyncWrite,
  type OwnershipAcceptance,
  type ScopeRotation,
} from '@ultra-tasks/account-crypto';
import { AccountError, digest, type UltraConfig } from './security';
import { accountById, one, type UltraDb, type SessionRow } from './store';

export interface ScopeRow {
  id: string;
  kind: 'personal' | 'project';
  owner_id: string;
  owner_key: JsonWebKey;
  epoch: number;
  generation: number;
  control_version: number;
  sequence: number;
  state: 'active' | 'migrating' | 'rotating';
  migration_device: string | null;
  rotation: ScopeRotation | null;
  ownership_chain?: OwnershipAcceptance[];
}
export interface MemberRow {
  account_id: string;
  role: 'owner' | 'editor' | 'viewer';
  membership: Membership;
}
export interface HeadRow {
  entity_id: string;
  revision: number;
  deleted: boolean;
  write: SyncWrite;
  bytes: number;
  mutation_id: string;
}
export const unsigned = <T extends { signature: string }>(
  value: T,
): Omit<T, 'signature'> => {
  const { signature: _signature, ...rest } = value;
  return rest;
};
export const liveSession = async (db: UltraDb, session: SessionRow): Promise<void> => {
  const now = BigInt(Date.now());
  if (
    !(await one(
      db,
      Prisma.sql`SELECT id FROM ultra_sessions WHERE id=${session.id} AND account_id=${session.account_id} AND revoked=false AND expires_at>${now} AND idle_expires_at>${now} FOR UPDATE`,
    ))
  )
    throw new AccountError(401);
};
/** Lock order: session, scope, membership/heads. Revocation and writes serialize on the scope. */
export const lockScope = async (
  db: UltraDb,
  id: string,
  accountId: string,
  write = false,
): Promise<{ scope: ScopeRow; member: MemberRow }> => {
  const scope = await one<ScopeRow>(
    db,
    Prisma.sql`SELECT * FROM ultra_scopes WHERE id=${id} FOR UPDATE`,
  );
  const member = await one<MemberRow>(
    db,
    Prisma.sql`SELECT * FROM ultra_scope_members WHERE scope_id=${id} AND account_id=${accountId}`,
  );
  if (!scope || !member) throw new AccountError(404, 'Project or sync scope unavailable');
  if (write && member.role === 'viewer')
    throw new AccountError(403, 'Viewers cannot change shared content');
  return { scope, member };
};
export const scopeInfo = async (
  db: UltraDb,
  scope: ScopeRow,
  compact = false,
): Promise<ScopeInfo> => ({
  id: scope.id,
  kind: scope.kind,
  ownerId: scope.owner_id,
  ownerKey: scope.owner_key,
  epoch: scope.epoch,
  generation: scope.generation,
  controlVersion: scope.control_version,
  sequence: scope.sequence,
  state: scope.state,
  members: compact
    ? []
    : (
        await db.$queryRaw<MemberRow[]>(
          Prisma.sql`SELECT * FROM ultra_scope_members WHERE scope_id=${scope.id} ORDER BY account_id`,
        )
      ).map((row) => row.membership),
  ...(scope.rotation ? { rotation: scope.rotation } : {}),
  ownershipChain: scope.ownership_chain ?? [],
});
export const snapshot = async (
  db: UltraDb,
  scope: ScopeRow,
  compact = false,
): Promise<ScopeSnapshot> => ({
  ...(compact ? { controlUnchanged: true } : {}),
  scope: await scopeInfo(db, scope, compact),
  heads: (
    await db.$queryRaw<HeadRow[]>(
      Prisma.sql`SELECT * FROM ultra_record_heads WHERE scope_id=${scope.id} ORDER BY entity_id`,
    )
  ).map((row) => row.write),
  manifests: (
    await db.$queryRaw<{ manifest: Mutation }[]>(
      Prisma.sql`SELECT DISTINCT m.manifest FROM ultra_scope_mutations m JOIN ultra_record_heads h ON h.mutation_id=m.id AND h.scope_id=m.scope_id WHERE m.scope_id=${scope.id}`,
    )
  ).map((row) => row.manifest),
});
export const validateMembership = async (
  db: UltraDb,
  config: UltraConfig,
  scope: Pick<ScopeRow, 'id' | 'owner_id' | 'owner_key' | 'epoch'>,
  membership: Membership,
): Promise<void> => {
  const a = membership.authorization;
  const recipient = await accountById(db, a.accountId);
  if (
    !recipient?.verified ||
    a.serverId !== config.serverId ||
    a.scopeId !== scope.id ||
    a.ownerId !== scope.owner_id ||
    a.epoch !== scope.epoch ||
    (a.role === 'owner') !== (a.accountId === scope.owner_id) ||
    canonical(recipient.bundle.encryptionPublicKey) !==
      canonical(a.encryptionPublicKey) ||
    canonical(recipient.bundle.signingPublicKey) !== canonical(a.signingPublicKey) ||
    !(await verify(scope.owner_key, a, membership.signature))
  )
    throw new AccountError(400, 'Invalid encrypted membership authorization');
};
export const putMember = (db: UltraDb, scopeId: string, membership: Membership) =>
  db.$executeRaw(
    Prisma.sql`INSERT INTO ultra_scope_members (scope_id,account_id,role,membership) VALUES (${scopeId},${membership.authorization.accountId},${membership.authorization.role},${JSON.stringify(membership)}::jsonb) ON CONFLICT (scope_id,account_id) DO UPDATE SET role=excluded.role,membership=excluded.membership`,
  );

export const validateMutation = async (
  config: UltraConfig,
  scope: ScopeRow,
  member: MemberRow,
  mutation: Mutation,
  rotating = false,
): Promise<void> => {
  const c = mutation.certificate;
  const epoch = scope.epoch + (rotating ? 1 : 0);
  const generation = scope.generation + (rotating ? 1 : 0);
  const authorization = mutation.membership.authorization;
  if (
    authorization.accountId !== member.account_id ||
    authorization.scopeId !== scope.id ||
    authorization.serverId !== config.serverId ||
    authorization.ownerId !== scope.owner_id ||
    authorization.epoch !== epoch ||
    authorization.role !== member.role ||
    !(await verify(scope.owner_key, authorization, mutation.membership.signature)) ||
    canonical(authorization.signingPublicKey) !==
      canonical(member.membership.authorization.signingPublicKey)
  )
    throw new AccountError(403, 'Invalid writer authorization');
  if (
    mutation.serverId !== config.serverId ||
    mutation.scopeId !== scope.id ||
    mutation.epoch !== epoch ||
    mutation.generation !== generation ||
    mutation.controlVersion !== scope.control_version ||
    mutation.deviceId !== c.deviceId ||
    c.serverId !== config.serverId ||
    c.accountId !== member.account_id ||
    !(await verify(
      member.membership.authorization.signingPublicKey,
      unsigned(c),
      c.signature,
    )) ||
    !(await verify(c.publicKey, unsigned(mutation), mutation.signature))
  )
    throw new AccountError(409, 'Scope changed or invalid transaction signature');
  const ids = new Set<string>();
  for (const { record } of mutation.writes) {
    const h = record.header;
    if (
      ids.has(h.entityId) ||
      h.serverId !== config.serverId ||
      h.scopeId !== scope.id ||
      h.actorId !== member.account_id ||
      h.deviceId !== c.deviceId ||
      h.epoch !== epoch ||
      h.generation !== generation ||
      h.controlVersion !== scope.control_version ||
      h.mutationId !== mutation.mutationId ||
      h.counter !== mutation.counter ||
      !(await verify(
        c.publicKey,
        { header: h, payload: record.payload },
        record.signature,
      ))
    )
      throw new AccountError(400, 'Invalid signed record or transaction footprint');
    ids.add(h.entityId);
  }
};

export const commitMutation = async (
  db: UltraDb,
  config: UltraConfig,
  scope: ScopeRow,
  member: MemberRow,
  mutation: Mutation,
): Promise<{ sequence: number; replay?: boolean }> => {
  const hash = digest(canonical(mutation));
  const receipt = await one<{
    counter: number;
    mutation_id: string;
    digest: string;
    sequence: number;
  }>(
    db,
    Prisma.sql`SELECT * FROM ultra_scope_receipts WHERE scope_id=${scope.id} AND account_id=${member.account_id} AND device_id=${mutation.deviceId}`,
  );
  if (receipt && mutation.counter <= receipt.counter) {
    if (
      mutation.counter === receipt.counter &&
      receipt.mutation_id === mutation.mutationId &&
      receipt.digest === hash
    )
      return { sequence: receipt.sequence, replay: true };
    throw new AccountError(409, 'Outbox counter already committed');
  }
  await validateMutation(config, scope, member, mutation);
  if (!receipt) {
    const devices = await one<{ count: bigint }>(
      db,
      Prisma.sql`SELECT count(*) AS count FROM ultra_scope_receipts WHERE scope_id=${scope.id}`,
    );
    if (Number(devices?.count) >= 5000)
      throw new AccountError(413, 'Scope device limit reached');
  }
  if (mutation.counter !== (receipt?.counter ?? 0) + 1)
    throw new AccountError(409, 'Outbox counter must be sequential');
  if (scope.state === 'rotating')
    throw new AccountError(409, 'Project key update is in progress');
  if (scope.state === 'migrating' && scope.migration_device !== mutation.deviceId)
    throw new AccountError(
      409,
      'Personal data migration is in progress on another device',
    );
  const current = await db.$queryRaw<HeadRow[]>(
    Prisma.sql`SELECT * FROM ultra_record_heads WHERE scope_id=${scope.id}`,
  );
  const heads = new Map(current.map((row) => [row.entity_id, row]));
  let bytes = current.reduce((total, row) => total + row.bytes, 0);
  for (const write of mutation.writes) {
    const h = write.record.header;
    const previous = heads.get(h.entityId);
    if (
      h.baseRevision !== (previous?.revision ?? 0) ||
      (previous?.deleted && !write.deleted && !write.restore) ||
      (previous && previous.write.record.header.entityType !== h.entityType)
    )
      throw new AccountError(409, 'Record revision conflict');
    bytes += Buffer.byteLength(JSON.stringify(write)) - (previous?.bytes ?? 0);
    if (!previous) heads.set(h.entityId, {} as HeadRow);
  }
  if (
    heads.size > (scope.kind === 'personal' ? 50000 : 5000) ||
    bytes > (scope.kind === 'personal' ? 32 : 8) * 1024 * 1024
  )
    throw new AccountError(
      413,
      'Encrypted scope quota reached; local changes are retained',
    );
  await db.$executeRaw(
    Prisma.sql`DELETE FROM ultra_scope_mutations m WHERE m.scope_id=${scope.id} AND m.created_at<${BigInt(Date.now() - 30 * 86400000)} AND NOT EXISTS (SELECT 1 FROM ultra_record_heads h WHERE h.scope_id=m.scope_id AND h.mutation_id=m.id)`,
  );
  const history = await one<{ bytes: bigint | null }>(
    db,
    Prisma.sql`SELECT sum(octet_length(manifest::text)) AS bytes FROM ultra_scope_mutations WHERE scope_id=${scope.id}`,
  );
  if (
    Number(history?.bytes ?? 0) + Buffer.byteLength(JSON.stringify(mutation)) >
    128 * 1024 * 1024
  )
    throw new AccountError(
      413,
      'Encrypted history quota reached; local changes are retained',
    );
  const sequence = scope.sequence + 1;
  await db.$executeRaw(
    Prisma.sql`INSERT INTO ultra_scope_mutations (id,scope_id,sequence,manifest,created_at) VALUES (${mutation.mutationId},${scope.id},${sequence},${JSON.stringify(mutation)}::jsonb,${BigInt(Date.now())})`,
  );
  for (const write of mutation.writes) {
    const h = write.record.header;
    await db.$executeRaw(
      Prisma.sql`INSERT INTO ultra_record_heads (scope_id,entity_id,revision,mutation_id,deleted,write,bytes) VALUES (${scope.id},${h.entityId},${h.revision},${mutation.mutationId},${write.deleted},${JSON.stringify(write)}::jsonb,${Buffer.byteLength(JSON.stringify(write))}) ON CONFLICT (scope_id,entity_id) DO UPDATE SET revision=excluded.revision,mutation_id=excluded.mutation_id,deleted=excluded.deleted,write=excluded.write,bytes=excluded.bytes`,
    );
  }
  await db.$executeRaw(
    Prisma.sql`UPDATE ultra_scopes SET sequence=${sequence} WHERE id=${scope.id}`,
  );
  await db.$executeRaw(
    Prisma.sql`INSERT INTO ultra_scope_receipts (scope_id,account_id,device_id,counter,mutation_id,digest,sequence) VALUES (${scope.id},${member.account_id},${mutation.deviceId},${mutation.counter},${mutation.mutationId},${hash},${sequence}) ON CONFLICT (scope_id,account_id,device_id) DO UPDATE SET counter=excluded.counter,mutation_id=excluded.mutation_id,digest=excluded.digest,sequence=excluded.sequence`,
  );
  // Keep 30 days of catch-up history plus every manifest authenticating a current head.
  await db.$executeRaw(
    Prisma.sql`DELETE FROM ultra_scope_mutations m WHERE m.scope_id=${scope.id} AND m.created_at<${BigInt(Date.now() - 30 * 86400000)} AND NOT EXISTS (SELECT 1 FROM ultra_record_heads h WHERE h.scope_id=m.scope_id AND h.mutation_id=m.id)`,
  );
  return { sequence };
};
