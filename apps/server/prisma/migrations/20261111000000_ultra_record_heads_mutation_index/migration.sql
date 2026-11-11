-- Incremental catch-up returns only heads written by mutations after a client's
-- cursor: mutations are found by (scope_id, sequence), then their current heads by
-- this index. It also serves the retention sweep's referenced-manifest check.
CREATE INDEX "ultra_record_heads_scope_id_mutation_id_idx" ON "ultra_record_heads"("scope_id", "mutation_id");
