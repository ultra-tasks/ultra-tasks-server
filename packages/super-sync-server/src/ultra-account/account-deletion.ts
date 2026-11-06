import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { verify, type ScopeRotation } from '@ultra-tasks/account-crypto';
import { AccountError, requireRecent, type UltraConfig } from './security';
import { type UltraDb, type AccountRow, type SessionRow } from './store';
import { type ScopeRow } from './scope-store';

/** The caller holds the live session and account locks. Membership loss freezes writes immediately. */
export const deleteUltraAccount = async (
  tx: UltraDb,
  config: UltraConfig,
  session: SessionRow,
  account: AccountRow,
  input: { vaultVersion: number; signature: string },
): Promise<{ deleted: true }> => {
  requireRecent(session);
  if (
    account.vault_version !== input.vaultVersion ||
    !(await verify(
      account.bundle.signingPublicKey,
      {
        action: 'delete-account',
        serverId: config.serverId,
        accountId: account.id,
        vaultVersion: input.vaultVersion,
      },
      input.signature,
    ))
  )
    throw new AccountError(409, 'Sign in again before deleting the account');
  const rows = await tx.$queryRaw<ScopeRow[]>(
    Prisma.sql`SELECT s.* FROM ultra_scopes s JOIN ultra_scope_members m ON m.scope_id=s.id WHERE m.account_id=${account.id} ORDER BY s.id FOR UPDATE OF s`,
  );
  if (rows.some((scope) => scope.kind === 'project' && scope.owner_id === account.id))
    throw new AccountError(
      409,
      'Transfer or delete every project you own before deleting your account',
    );
  for (const scope of rows) {
    if (scope.kind === 'personal') {
      await tx.$executeRaw(Prisma.sql`DELETE FROM ultra_scopes WHERE id=${scope.id}`);
      continue;
    }
    // A departing member may already know a staged next key. Discard that stage
    // and let any unlocked owner device provision a fresh epoch automatically.
    const rotation: ScopeRotation = {
      id: randomUUID(),
      kind: 'member-left',
      controllerId: scope.owner_id,
      members: [],
    };
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM ultra_rotation_heads WHERE scope_id=${scope.id}`,
    );
    await tx.$executeRaw(
      Prisma.sql`UPDATE ultra_scopes SET state='rotating',control_version=control_version+1,rotation=${JSON.stringify(rotation)}::jsonb WHERE id=${scope.id}`,
    );
    await tx.$executeRaw(
      Prisma.sql`UPDATE ultra_scope_invites SET membership=NULL,state='provisioning' WHERE scope_id=${scope.id} AND state<>'accepted'`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM ultra_scope_transfers WHERE scope_id=${scope.id}`,
    );
  }
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_scope_members WHERE account_id=${account.id}`,
  );
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_scope_invites WHERE recipient_id=${account.id} OR email=${account.email}`,
  );
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_scope_transfers WHERE recipient_id=${account.id}`,
  );
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_scope_receipts WHERE account_id=${account.id}`,
  );
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_challenges WHERE account_id=${account.id}`,
  );
  // Factor/session/challenge/refresh records cascade; no content key is escrowed.
  const deleted = await tx.$executeRaw(
    Prisma.sql`DELETE FROM ultra_accounts WHERE id=${account.id}`,
  );
  if (!deleted) throw new AccountError(401);
  return { deleted: true };
};
