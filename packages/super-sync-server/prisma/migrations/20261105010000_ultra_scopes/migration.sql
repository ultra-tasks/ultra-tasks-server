-- V2 encrypted heads are isolated from the legacy operation log.
CREATE TABLE "ultra_scopes" (
  "id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "owner_id" TEXT NOT NULL,
  "owner_key" JSONB NOT NULL, "epoch" INTEGER NOT NULL DEFAULT 1,
  "generation" INTEGER NOT NULL DEFAULT 1, "control_version" INTEGER NOT NULL DEFAULT 1,
  "sequence" INTEGER NOT NULL DEFAULT 0, "state" TEXT NOT NULL DEFAULT 'active',
  "migration_device" TEXT, "rotation" JSONB
);
CREATE UNIQUE INDEX "ultra_scopes_personal_owner" ON "ultra_scopes" ("owner_id") WHERE "kind"='personal';
CREATE TABLE "ultra_scope_members" (
  "scope_id" TEXT NOT NULL REFERENCES "ultra_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "account_id" TEXT NOT NULL, "role" TEXT NOT NULL, "membership" JSONB NOT NULL,
  PRIMARY KEY ("scope_id", "account_id")
);
CREATE INDEX "ultra_scope_members_account_id_idx" ON "ultra_scope_members"("account_id");
CREATE TABLE "ultra_scope_invites" (
  "id" TEXT PRIMARY KEY, "scope_id" TEXT NOT NULL REFERENCES "ultra_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "recipient_id" TEXT, "email" TEXT, "role" TEXT NOT NULL, "expires_at" BIGINT NOT NULL,
  "membership" JSONB, "state" TEXT NOT NULL DEFAULT 'pending', "request" JSONB NOT NULL
);
CREATE INDEX "ultra_scope_invites_recipient_id_idx" ON "ultra_scope_invites"("recipient_id");
CREATE TABLE "ultra_record_heads" (
  "scope_id" TEXT NOT NULL REFERENCES "ultra_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "entity_id" TEXT NOT NULL, "revision" INTEGER NOT NULL, "mutation_id" TEXT NOT NULL,
  "deleted" BOOLEAN NOT NULL, "write" JSONB NOT NULL, "bytes" INTEGER NOT NULL,
  PRIMARY KEY ("scope_id", "entity_id")
);
CREATE TABLE "ultra_scope_mutations" (
  "id" TEXT PRIMARY KEY, "scope_id" TEXT NOT NULL REFERENCES "ultra_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sequence" INTEGER NOT NULL, "manifest" JSONB NOT NULL, "created_at" BIGINT NOT NULL,
  UNIQUE ("scope_id", "sequence")
);
CREATE TABLE "ultra_scope_receipts" (
  "scope_id" TEXT NOT NULL REFERENCES "ultra_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "device_id" TEXT NOT NULL, "counter" INTEGER NOT NULL, "mutation_id" TEXT NOT NULL,
  "digest" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
  PRIMARY KEY ("scope_id", "device_id")
);
CREATE TABLE "ultra_scope_checkpoints" (
  "scope_id" TEXT NOT NULL REFERENCES "ultra_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sequence" INTEGER NOT NULL, "snapshot" JSONB NOT NULL, PRIMARY KEY ("scope_id", "sequence")
);
CREATE TABLE "ultra_rotation_heads" (
  "scope_id" TEXT NOT NULL REFERENCES "ultra_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "entity_id" TEXT NOT NULL, "write" JSONB NOT NULL, "manifest" JSONB NOT NULL,
  PRIMARY KEY ("scope_id", "entity_id")
);
