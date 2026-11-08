-- Additive, opt-in Better Auth access sessions. Existing identities, OPAQUE
-- registration records, vaults, factors, and refresh families remain unchanged.
-- At most one short-lived access session per existing bounded device session.
CREATE TABLE "ultra_better_auth_sessions" (
  "id" TEXT PRIMARY KEY,
  "session_id" TEXT NOT NULL UNIQUE REFERENCES "ultra_sessions"("id") ON DELETE CASCADE,
  -- Account deletion cascades through session_id. A second FK to accounts would
  -- acquire an account key-share lock while refresh already holds its session,
  -- reversing the account -> session lock order used by security changes.
  "account_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_at" BIGINT NOT NULL,
  "data" JSONB NOT NULL
);
CREATE INDEX "ultra_better_auth_sessions_expires_at_idx"
  ON "ultra_better_auth_sessions"("expires_at");
