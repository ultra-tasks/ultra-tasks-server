CREATE TABLE "ultra_calendar_feeds" (
  "id" TEXT PRIMARY KEY,
  "account_id" TEXT NOT NULL REFERENCES "ultra_accounts"("id") ON DELETE CASCADE,
  "label" TEXT NOT NULL,
  "privacy" TEXT NOT NULL CHECK ("privacy" IN ('busy', 'titles')),
  "token_hash" TEXT NOT NULL UNIQUE,
  "body" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "updated_at" BIGINT NOT NULL
);
CREATE INDEX "ultra_calendar_feeds_account_id_idx" ON "ultra_calendar_feeds"("account_id");
