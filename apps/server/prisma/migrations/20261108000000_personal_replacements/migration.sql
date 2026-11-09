-- Staged ciphertext is invisible to readers until the complete replacement commits.
CREATE TABLE "ultra_personal_replacements" (
  "scope_id" TEXT PRIMARY KEY REFERENCES "ultra_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "id" TEXT NOT NULL, "device_id" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
  "generation" INTEGER NOT NULL, "control_version" INTEGER NOT NULL,
  "record_count" INTEGER NOT NULL, "batches" JSONB NOT NULL, "committed_sequence" INTEGER
);
CREATE TABLE "ultra_personal_replacement_batches" (
  "scope_id" TEXT NOT NULL REFERENCES "ultra_personal_replacements"("scope_id") ON DELETE CASCADE ON UPDATE CASCADE,
  "digest" TEXT NOT NULL, "manifest" JSONB NOT NULL,
  PRIMARY KEY ("scope_id", "digest")
);
