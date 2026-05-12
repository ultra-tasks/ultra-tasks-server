import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));

describe('performance migrations', () => {
  it('keeps the entity sequence index out of blocking Prisma migrations', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260511000000_add_entity_sequence_index/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('intentionally non-blocking');
    expect(migrationSql).toContain('RUN_POST_MIGRATION_INDEXES=true ./scripts/deploy.sh');
    expect(migrationSql).toContain(
      '"operations_user_id_entity_type_entity_id_server_seq_idx"',
    );
    expect(migrationSql).not.toMatch(/^\s*CREATE\s+INDEX\b/im);
    expect(migrationSql).not.toMatch(/^\s*DROP\s+INDEX\b/im);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('runs migrations before replacing the app during compose deploys', () => {
    const deployScript = readFileSync(join(currentDir, '../scripts/deploy.sh'), 'utf8');
    const dockerfile = readFileSync(join(currentDir, '../Dockerfile'), 'utf8');
    const composeFile = readFileSync(join(currentDir, '../docker-compose.yml'), 'utf8');
    const envExample = readFileSync(join(currentDir, '../env.example'), 'utf8');
    const readmeFile = readFileSync(join(currentDir, '../README.md'), 'utf8');
    const deployDbScalarScript = readFileSync(
      join(currentDir, '../scripts/deploy-db-scalar.mjs'),
      'utf8',
    );
    const buildComposeFile = readFileSync(
      join(currentDir, '../docker-compose.build.yml'),
      'utf8',
    );
    const schemaFile = readFileSync(join(currentDir, '../prisma/schema.prisma'), 'utf8');
    const migrationCommand =
      'docker compose $COMPOSE_FILES run --rm --no-deps supersync npx prisma "$@"';
    const indexSql =
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS %s ON %s("user_id", "entity_type", "entity_id", "server_seq");';
    const failedMigrationSql =
      "SELECT 1 FROM _prisma_migrations WHERE migration_name = '$ENTITY_SEQUENCE_INDEX_MIGRATION' AND finished_at IS NULL AND rolled_back_at IS NULL LIMIT 1;";
    const recoveryCall = '\n    recover_failed_entity_sequence_index_migration\n';
    const migrationCall = '\nrun_migrations_with_retry\n';
    const indexCall = '\nrun_post_migration_indexes\n\n# The migration above';
    const startCommand = 'up -d --wait --wait-timeout "$WAIT_TIMEOUT"';
    const recoveryCallIndex = deployScript.indexOf(recoveryCall);
    const migrationCallIndex = deployScript.indexOf(migrationCall);
    const indexCallIndex = deployScript.indexOf(indexCall);
    const startCommandIndex = deployScript.indexOf(startCommand);
    const recoveryFunction = deployScript.slice(
      deployScript.indexOf('recover_failed_entity_sequence_index_migration()'),
      deployScript.indexOf('run_post_migration_indexes()'),
    );

    expect(deployScript).toContain('load_deploy_env');
    expect(deployScript).toContain('trim_deploy_env_value');
    expect(deployScript).toContain('inherit_errexit');
    expect(deployScript).toContain('value="${value%%[[:space:]]#*}"');
    expect(deployScript).toContain('EXTERNAL_DB_START_SERVICES="supersync caddy"');
    expect(deployScript).toContain('--no-deps $EXTERNAL_DB_START_SERVICES');
    expect(deployScript).toContain('run_database_scalar');
    expect(deployScript).toContain('has_placeholder_ghcr_credentials');
    expect(deployScript).toContain(
      'Skipping GHCR login (placeholder credentials in .env)',
    );
    expect(deployScript).toContain(
      '-v "$SERVER_DIR/scripts/deploy-db-scalar.mjs:/app/deploy-db-scalar.mjs:ro"',
    );
    expect(deployScript).toContain('supersync node /app/deploy-db-scalar.mjs "$1"');
    expect(deployScript).toContain('prisma db execute --stdin');
    expect(deployScript).not.toContain('requires POSTGRES_SERVICE');
    expect(deployScript).toContain('GHCR_USER|GHCR_TOKEN|RUN_POST_MIGRATION_INDEXES');
    expect(deployScript).toContain('POSTGRES_WAIT_TIMEOUT');
    expect(deployScript).toContain('POSTGRES_SERVICE="${POSTGRES_SERVICE-postgres}"');
    expect(deployScript).toContain('MIGRATION_WAIT_TIMEOUT');
    expect(deployScript).toContain('MIGRATION_RETRY_INTERVAL');
    expect(deployScript).toContain('MIGRATION_WAIT_TIMEOUT must be a positive integer');
    expect(deployScript).toContain('MIGRATION_RETRY_INTERVAL must be a positive integer');
    expect(deployScript).toContain('20260511000000_add_entity_sequence_index');
    expect(deployScript).toContain(failedMigrationSql);
    expect(recoveryFunction).toContain('pg_try_advisory_lock(72707369)');
    expect(recoveryFunction).toContain('pg_advisory_unlock(72707369)');
    expect(recoveryFunction).toContain('if ! migration_table_exists=');
    expect(recoveryFunction).toContain('if ! failed_migration=');
    expect(recoveryFunction).toContain('if ! advisory_lock_available=');
    expect(recoveryFunction).toContain('drop_invalid_entity_sequence_index');
    expect(deployScript).toContain('migrate resolve --rolled-back');
    expect(deployScript).toContain('migrate deploy after known index migration recovery');
    expect(deployScript).toContain('Prisma advisory migration lock');
    expect(deployScript).toContain("grep -qiE 'advisory[[:space:]-]+lock'");
    expect(deployScript).not.toContain('|P1002');
    expect(deployScript).toContain('quote_sql_identifier');
    expect(deployScript).toContain('get_current_db_schema');
    expect(deployScript).toContain('entity_sequence_index_state_sql');
    expect(deployScript).toContain('idx_ns.nspname = current_schema()');
    expect(deployScript).toContain('i.indnkeyatts AS key_column_count');
    expect(deployScript).toContain('WHERE k.ord <= i.indnkeyatts');
    expect(deployScript).toContain('key_column_count = 4');
    expect(deployScript).toContain(
      "key_columns = ARRAY['user_id', 'entity_type', 'entity_id', 'server_seq']::name[]",
    );
    expect(deployScript).toContain('require_valid_entity_sequence_index_definition');
    expect(deployScript).toContain('unexpected definition');
    expect(deployScript).toContain('warn_if_entity_sequence_index_missing');
    expect(deployScript).toContain(
      'warn_if_entity_sequence_index_missing || echo "WARNING: Could not verify optional $ENTITY_SEQUENCE_INDEX_NAME index state; continuing."',
    );
    expect(deployScript).toContain('RUN_POST_MIGRATION_INDEXES');
    expect(deployScript).toContain(indexSql);
    expect(deployScript).toContain('DROP INDEX CONCURRENTLY IF EXISTS');
    expect(deployScript).toContain('if ! index_state=');
    expect(deployScript).not.toContain('migrate resolve --applied');
    expect(deployScript).toContain(migrationCommand);
    expect(deployScript).toMatch(/else\s+exit_code=\$\?/);
    expect(deployScript).not.toMatch(/fi\s+exit_code=\$\?/);
    expect(deployScript).toContain('RUN_MIGRATIONS_ON_STARTUP');
    expect(deployScript).toContain('export RUN_MIGRATIONS_ON_STARTUP=false');
    expect(recoveryCallIndex).toBeGreaterThan(-1);
    expect(migrationCallIndex).toBeGreaterThan(-1);
    expect(indexCallIndex).toBeGreaterThan(-1);
    expect(startCommandIndex).toBeGreaterThan(-1);
    expect(recoveryCallIndex).toBeLessThan(migrationCallIndex);
    expect(migrationCallIndex).toBeLessThan(startCommandIndex);
    expect(migrationCallIndex).toBeLessThan(indexCallIndex);
    expect(indexCallIndex).toBeLessThan(startCommandIndex);
    expect(dockerfile).toContain('RUN_MIGRATIONS_ON_STARTUP');
    expect(dockerfile).toContain('ENV RUN_MIGRATIONS_ON_STARTUP=false');
    expect(dockerfile).toContain('npx prisma migrate deploy || exit 1');
    expect(dockerfile).toContain('exec node dist/src/index.js');
    expect(composeFile).toContain(
      'RUN_MIGRATIONS_ON_STARTUP=${RUN_MIGRATIONS_ON_STARTUP:-false}',
    );
    expect(composeFile).toContain('DATABASE_URL=${DATABASE_URL:-postgresql://');
    expect(buildComposeFile).toContain('./scripts/deploy.sh --build');
    expect(buildComposeFile).not.toContain('up -d --build');
    expect(envExample).not.toMatch(/^GHCR_USER=/m);
    expect(envExample).not.toMatch(/^GHCR_TOKEN=/m);
    expect(envExample).toMatch(/^# POSTGRES_SERVICE=$/m);
    expect(envExample).not.toMatch(/^POSTGRES_SERVICE=/m);
    expect(readmeFile).toContain('Upgrade note');
    expect(readmeFile).toMatch(/set\s+`POSTGRES_SERVICE=` to the empty value/);
    expect(readmeFile).toContain('migrate resolve --rolled-back');
    expect(readmeFile).toContain('same schema/search path used by');
    expect(readmeFile).toContain('SET search_path TO public');
    expect(readmeFile).toContain('DROP INDEX CONCURRENTLY IF EXISTS');
    expect(readmeFile).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(readmeFile).toContain('out-of-band index');
    expect(readmeFile).toContain('dependencies disabled');
    expect(deployDbScalarScript).toContain('Scalar deploy probe');
    expect(deployDbScalarScript).toContain('$queryRawUnsafe');
    expect(deployDbScalarScript).toContain('$disconnect');
    expect(schemaFile).toContain('@@index([userId, entityType, entityId])');
    expect(schemaFile).toContain('built out-of-band');
    expect(schemaFile).not.toContain(
      '@@index([userId, entityType, entityId, serverSeq])',
    );
  });
});
