CREATE TABLE "ultra_socket_tickets" (
  "digest" TEXT PRIMARY KEY,
  "session_id" TEXT NOT NULL REFERENCES "ultra_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "account_id" TEXT NOT NULL,
  "scope_ids" JSONB NOT NULL,
  "expires_at" BIGINT NOT NULL
);
CREATE INDEX "ultra_socket_tickets_expires_at_idx" ON "ultra_socket_tickets"("expires_at");
CREATE TABLE "ultra_scope_transfers" (
  "id" TEXT PRIMARY KEY,
  "scope_id" TEXT NOT NULL REFERENCES "ultra_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "recipient_id" TEXT NOT NULL,
  "epoch" INTEGER NOT NULL,
  "control_version" INTEGER NOT NULL,
  "expires_at" BIGINT NOT NULL,
  "offer" JSONB NOT NULL
);
CREATE INDEX "ultra_scope_transfers_recipient_id_idx" ON "ultra_scope_transfers"("recipient_id");
ALTER TABLE "ultra_scopes" ADD COLUMN "ownership_chain" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "ultra_scope_receipts" ADD COLUMN "account_id" TEXT;
UPDATE "ultra_scope_receipts" r SET "account_id" = m.manifest->'certificate'->>'accountId'
FROM "ultra_scope_mutations" m WHERE m.id = r.mutation_id;
-- A receipt whose manifest was retired cannot bind an actor safely; its old
-- device bootstraps its next counter from the own-account receipt endpoint.
DELETE FROM "ultra_scope_receipts" WHERE "account_id" IS NULL;
ALTER TABLE "ultra_scope_receipts" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "ultra_scope_receipts" DROP CONSTRAINT "ultra_scope_receipts_pkey";
ALTER TABLE "ultra_scope_receipts" ADD PRIMARY KEY ("scope_id", "account_id", "device_id");
