CREATE INDEX "ultra_accounts_verified_created_at_idx" ON "ultra_accounts" ("verified", "created_at");
CREATE INDEX "ultra_challenges_account_kind_idx" ON "ultra_challenges" ("account_id", "kind");
