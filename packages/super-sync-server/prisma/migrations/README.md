# Migration authoring rules

Prisma 5.x wraps every migration in a transaction. PostgreSQL forbids
`CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` inside a transaction
block, so a CONCURRENTLY migration always fails the normal
`prisma migrate deploy` path (P3018 / SQLSTATE 25001).

`scripts/migrate-deploy.sh` recovers from this generically: on that specific
failure it reads the failing migration's name from Prisma's output, runs *that
migration's own `migration.sql`* out-of-band (no transaction,
statement-by-statement), marks it applied, and retries. It hardcodes no
migration names — but it relies on the rules below. Recovery is also exercised
by `tests/migration-sql.spec.ts` and `tests/migrate-deploy-script.spec.ts`.

## Rules for a CONCURRENTLY index migration

1. **Drop-then-create, idempotent.** A re-run after a partial/interrupted
   concurrent build (which leaves an `INVALID` index) must succeed:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS "my_idx";
   CREATE INDEX CONCURRENTLY "my_idx" ON "operations"(...) WHERE ...;
   ```

   Do **not** use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` instead — a leftover
   `INVALID` index has the right name but is unusable, so `IF NOT EXISTS` would
   skip rebuilding it.

2. **One statement per logical block, terminated by `;` at end of line.** The
   out-of-band splitter ends a statement when a line ends with `;`. Multi-line
   statements are fine (they are collapsed to one line before execution, which
   is safe for index DDL).

3. **Full-line `--` comments only.** Trailing/inline comments after SQL on the
   same line are not stripped.

4. **No `;` inside string literals.** The splitter treats any end-of-line `;`
   as a statement terminator. (True for all index DDL; the `WHERE op_type IN
   ('A', 'B')` form is fine — no semicolons.)

5. **No `BEGIN` / `COMMIT` / `DROP TABLE`** in CONCURRENTLY migrations. The
   recovery guard only ever auto-resolves a migration whose own SQL contains
   `INDEX … CONCURRENTLY`; anything else fails loudly and is never
   auto-marked-applied.

A migration that violates these is not auto-recovered: `migrate-deploy.sh`
prints exact manual recovery commands and exits non-zero.
