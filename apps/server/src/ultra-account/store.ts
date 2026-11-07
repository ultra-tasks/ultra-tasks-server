import { Prisma } from '@prisma/client';
import type { AccountBundle } from '@ultra-tasks/account-crypto';

export type UltraDb = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export type UltraTransaction = <T>(run: (db: UltraDb) => Promise<T>) => Promise<T>;
export interface AccountRow {
  id: string;
  email: string;
  username: string | null;
  display_name: string;
  verified: boolean;
  registration_record: string;
  bundle: AccountBundle;
  vault_version: number;
  created_at: bigint;
}
export interface SessionRow {
  id: string;
  account_id: string;
  device_name: string;
  auth_at: bigint;
  expires_at: bigint;
  idle_expires_at: bigint;
  revoked: boolean;
}
export interface FactorRow {
  id: string;
  account_id: string;
  kind: 'totp' | 'webauthn';
  enabled: boolean;
  data: Record<string, unknown>;
  last_step: bigint;
}
export const one = async <T>(db: UltraDb, sql: Prisma.Sql): Promise<T | undefined> =>
  (await db.$queryRaw<T[]>(sql))[0];
export const accountById = (db: UltraDb, id: string) =>
  one<AccountRow>(db, Prisma.sql`SELECT * FROM ultra_accounts WHERE id = ${id}`);
export const accountByIdentifier = (db: UltraDb, identifier: string) =>
  one<AccountRow>(
    db,
    Prisma.sql`SELECT * FROM ultra_accounts WHERE email = ${identifier} OR username = ${identifier}`,
  );
export const factors = (db: UltraDb, accountId: string) =>
  db.$queryRaw<FactorRow[]>(
    Prisma.sql`SELECT * FROM ultra_factors WHERE account_id = ${accountId} AND enabled = true ORDER BY id`,
  );
export const publicAccount = (account: AccountRow) => ({
  id: account.id,
  email: account.email,
  username: account.username,
  displayName: account.display_name,
  vaultVersion: account.vault_version,
});
