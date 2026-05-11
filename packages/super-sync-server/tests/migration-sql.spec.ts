import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));

describe('performance migrations', () => {
  it('adds the entity sequence index without a blocking or destructive migration', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260511000000_add_entity_sequence_index/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(migrationSql).toContain(
      '"operations_user_id_entity_type_entity_id_server_seq_idx"',
    );
    expect(migrationSql).toContain(
      'ON "operations"("user_id", "entity_type", "entity_id", "server_seq")',
    );
    expect(migrationSql).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('runs migrations before replacing the app during compose deploys', () => {
    const deployScript = readFileSync(join(currentDir, '../scripts/deploy.sh'), 'utf8');
    const dockerfile = readFileSync(join(currentDir, '../Dockerfile'), 'utf8');
    const composeFile = readFileSync(join(currentDir, '../docker-compose.yml'), 'utf8');
    const migrationCommand = 'run --rm --no-deps supersync npx prisma migrate deploy';
    const startCommand = 'up -d --wait --wait-timeout "$WAIT_TIMEOUT"';

    expect(deployScript).toContain('POSTGRES_WAIT_TIMEOUT');
    expect(deployScript).toContain('POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"');
    expect(deployScript).toContain(migrationCommand);
    expect(deployScript).toContain('RUN_MIGRATIONS_ON_STARTUP');
    expect(deployScript.indexOf(migrationCommand)).toBeLessThan(
      deployScript.indexOf(startCommand),
    );
    expect(dockerfile).toContain('RUN_MIGRATIONS_ON_STARTUP');
    expect(composeFile).toContain(
      'RUN_MIGRATIONS_ON_STARTUP=${RUN_MIGRATIONS_ON_STARTUP:-true}',
    );
  });
});
