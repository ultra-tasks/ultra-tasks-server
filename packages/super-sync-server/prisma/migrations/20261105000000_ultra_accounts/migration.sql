-- Additive, isolated v2 identity tables. No legacy users or sync data are changed.
CREATE TABLE "ultra_accounts" (
  "id" TEXT PRIMARY KEY, "email" TEXT NOT NULL UNIQUE, "username" TEXT UNIQUE,
  "display_name" TEXT NOT NULL DEFAULT '', "verified" BOOLEAN NOT NULL DEFAULT false,
  "registration_record" TEXT NOT NULL, "bundle" JSONB NOT NULL,
  "terms_accepted_at" BIGINT, "vault_version" INTEGER NOT NULL DEFAULT 1, "created_at" BIGINT NOT NULL
);
CREATE TABLE "ultra_sessions" (
  "id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL REFERENCES "ultra_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "device_name" TEXT NOT NULL, "created_at" BIGINT NOT NULL, "auth_at" BIGINT NOT NULL,
  "expires_at" BIGINT NOT NULL, "idle_expires_at" BIGINT NOT NULL, "revoked" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ultra_sessions_account_id_idx ON "ultra_sessions"("account_id");
CREATE TABLE "ultra_refresh_tokens" (
  "digest" TEXT PRIMARY KEY, "session_id" TEXT NOT NULL REFERENCES "ultra_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "used" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ultra_refresh_tokens_session_id_idx ON "ultra_refresh_tokens"("session_id");
CREATE TABLE "ultra_factors" (
  "id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL REFERENCES "ultra_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false, "data" JSONB NOT NULL,
  "last_step" BIGINT NOT NULL DEFAULT -1
);
CREATE INDEX ultra_factors_account_id_idx ON "ultra_factors"("account_id");
CREATE TABLE "ultra_recovery_codes" (
  "digest" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL REFERENCES "ultra_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX ultra_recovery_codes_account_id_idx ON "ultra_recovery_codes"("account_id");
CREATE TABLE "ultra_challenges" (
  "digest" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "account_id" TEXT, "expires_at" BIGINT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0, "data" JSONB NOT NULL
);
CREATE INDEX ultra_challenges_expires_at_idx ON "ultra_challenges"("expires_at");
