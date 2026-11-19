-- Additive only: no existing row is rewritten, dropped or backfilled. An older server binary
-- keeps working against this schema (it ignores the new columns and table). See
-- docs/account-devices-and-sessions.md for the rollout and rollback notes.
-- Keep comments free of semicolons: some tooling splits migrations into statements naively.

-- New-device email verification is on unless an account explicitly opts out. The constant
-- default is a catalog-only change on PostgreSQL 11+, so existing rows are not rewritten.
ALTER TABLE "ultra_accounts" ADD COLUMN "new_device_email" BOOLEAN NOT NULL DEFAULT true;

-- A trusted device is an opaque server-issued token, stored only as its SHA-256 digest. It
-- never authenticates by itself: it only waives the email check after a password proof.
CREATE TABLE "ultra_devices" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "token_digest" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,
    "last_seen_at" BIGINT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ultra_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ultra_devices_token_digest_key" ON "ultra_devices"("token_digest");

CREATE INDEX "ultra_devices_account_id_idx" ON "ultra_devices"("account_id");

ALTER TABLE "ultra_devices" ADD CONSTRAINT "ultra_devices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ultra_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A session remembers the trusted device it was issued for. Removing a device record clears
-- the link instead of ending the session.
ALTER TABLE "ultra_sessions" ADD COLUMN "device_id" TEXT;

CREATE INDEX "ultra_sessions_device_id_idx" ON "ultra_sessions"("device_id");

ALTER TABLE "ultra_sessions" ADD CONSTRAINT "ultra_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "ultra_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Refresh tokens identify their own generation: the session stores how many times it rotated.
-- A token for an older generation is a replay and revokes the session, however long ago it was
-- issued, with no per-token row. NULL marks a session issued before this release, whose tokens
-- are still the old random ones kept in ultra_refresh_tokens until its first refresh.
ALTER TABLE "ultra_sessions" ADD COLUMN "refresh_generation" INTEGER;

-- When the session was last signed in or refreshed. It drives device recognition and the
-- retirement of unused sessions. Sessions issued before this release keep 0 until they refresh.
ALTER TABLE "ultra_sessions" ADD COLUMN "refreshed_at" BIGINT NOT NULL DEFAULT 0;
