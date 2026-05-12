#!/bin/bash
# SuperSync Server Deployment Script
#
# Usage:
#   ./scripts/deploy.sh [--build]
#
# This script:
#   1. Validates Caddyfile syntax
#   2. Pulls latest image from GHCR (or builds locally with --build)
#   3. Applies database migrations before replacing the app container
#   4. Restarts containers and waits for health checks
#
# Options:
#   --build    Build locally instead of pulling from registry

set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

# Check required dependencies
for cmd in docker curl git; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: Required command '$cmd' not found"
        exit 1
    fi
done

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"

# Get domain from .env file
DOMAIN=""
if [ -f "$SERVER_DIR/.env" ]; then
    DOMAIN=$(grep -E '^DOMAIN=' "$SERVER_DIR/.env" | cut -d'=' -f2- | tr -d '"'"'" || true)
fi

if [ -z "$DOMAIN" ]; then
    echo "Warning: DOMAIN not set in .env, using localhost for health check"
    HEALTH_URL="http://localhost:1900/health"
else
    HEALTH_URL="https://$DOMAIN/health"
fi

# Parse arguments
BUILD_LOCAL=false
if [ "${1:-}" = "--build" ]; then
    BUILD_LOCAL=true
fi

echo "==> SuperSync Deployment"
echo "    Server dir: $SERVER_DIR"
echo "    Health URL: $HEALTH_URL"
echo ""

cd "$SERVER_DIR"

trim_deploy_env_value() {
    local value="$1"

    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

load_deploy_env() {
    local line
    local key
    local value

    [ -f ".env" ] || return 0

    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" != *=* ]] && continue

        key="${line%%=*}"
        value="${line#*=}"
        key="${key#"${key%%[![:space:]]*}"}"
        key="${key%"${key##*[![:space:]]}"}"

        case "$key" in
            GHCR_USER|GHCR_TOKEN|RUN_POST_MIGRATION_INDEXES|MIGRATION_WAIT_TIMEOUT|MIGRATION_RETRY_INTERVAL|DEPLOY_WAIT_TIMEOUT|POSTGRES_WAIT_TIMEOUT|POSTGRES_SERVICE) ;;
            *) continue ;;
        esac

        if [ -z "${!key+x}" ]; then
            value="$(trim_deploy_env_value "$value")"
            if [[ "$value" == \"*\" && "$value" == *\" ]]; then
                value="${value:1:${#value}-2}"
            elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
                value="${value:1:${#value}-2}"
            else
                value="${value%%[[:space:]]#*}"
                value="$(trim_deploy_env_value "$value")"
            fi
            export "$key=$value"
        fi
    done < ".env"
}

has_placeholder_ghcr_credentials() {
    [ "${GHCR_USER:-}" = "your-github-username" ] || [ "${GHCR_TOKEN:-}" = "your-github-token" ]
}

# Pull latest code (scripts, docker-compose.yml, etc.)
echo "==> Pulling latest code..."
git pull --ff-only || { echo "WARNING: git pull failed — continuing with current files"; }
echo ""

# Load deploy flags and GHCR credentials from .env. Docker Compose reads the
# service configuration from .env itself; this only covers values used directly
# by this script.
load_deploy_env

# Login to GHCR if credentials provided
if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
    if has_placeholder_ghcr_credentials; then
        echo "==> Skipping GHCR login (placeholder credentials in .env)"
        echo ""
    else
        echo "==> Logging in to GHCR..."
        echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
        echo ""
    fi
fi

# Check if monitoring compose exists and include it
COMPOSE_FILES="-f docker-compose.yml"
if [ -f "docker-compose.monitoring.yml" ]; then
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.monitoring.yml"
fi

EXTERNAL_DB_START_SERVICES="supersync caddy"
if [ -f "docker-compose.monitoring.yml" ]; then
    EXTERNAL_DB_START_SERVICES="$EXTERNAL_DB_START_SERVICES dozzle uptime-kuma"
fi

ENTITY_SEQUENCE_INDEX_MIGRATION="20260511000000_add_entity_sequence_index"
ENTITY_SEQUENCE_INDEX_NAME="operations_user_id_entity_type_entity_id_server_seq_idx"

# Validate Caddyfile syntax before deploying
CADDY_IMAGE=$(grep 'image:.*caddy:' docker-compose.yml | head -1 | awk '{print $2}' | tr -d '"'"'" || true)
if [ -z "$CADDY_IMAGE" ]; then
    echo "ERROR: Could not determine Caddy image from docker-compose.yml"
    exit 1
fi
echo "==> Validating Caddyfile (using $CADDY_IMAGE)..."
if ! docker run --rm -e "DOMAIN=${DOMAIN}" \
    -v "$SERVER_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile 2>&1; then
    echo ""
    echo "==> Caddyfile validation failed! Fix the errors above before deploying."
    exit 1
fi
echo ""

if [ "$BUILD_LOCAL" = true ]; then
    # Local build mode
    echo "==> Building locally..."
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.build.yml"
    docker compose $COMPOSE_FILES build
else
    # Pull from registry (default)
    echo "==> Pulling latest image..."
    docker compose $COMPOSE_FILES pull supersync
fi

run_prisma() {
    docker compose $COMPOSE_FILES run --rm --no-deps supersync npx prisma "$@"
}

run_database_scalar() {
    docker compose $COMPOSE_FILES run --rm --no-deps -T \
        -v "$SERVER_DIR/scripts/deploy-db-scalar.mjs:/app/deploy-db-scalar.mjs:ro" \
        supersync node /app/deploy-db-scalar.mjs "$1"
}

run_database_execute() {
    local sql="$1"

    printf '%s\n' "$sql" | docker compose $COMPOSE_FILES run --rm --no-deps -T supersync npx prisma db execute --stdin --schema prisma/schema.prisma
}

is_prisma_advisory_lock_error() {
    grep -qiE 'advisory[[:space:]-]+lock' <<<"$1"
}

quote_sql_identifier() {
    local identifier="${1//\"/\"\"}"

    printf '"%s"' "$identifier"
}

get_current_db_schema() {
    run_database_scalar "SELECT current_schema();"
}

entity_sequence_index_state_sql() {
    cat <<SQL
WITH target_indexes AS (
  SELECT
    i.indisvalid,
    i.indisready,
    tbl_ns.nspname AS table_schema,
    tbl.relname AS table_name,
    am.amname AS index_method,
    i.indisunique,
    i.indpred IS NULL AS has_no_predicate,
    i.indexprs IS NULL AS has_no_expressions,
    i.indnkeyatts AS key_column_count,
    ARRAY(
      SELECT a.attname
      FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE k.ord <= i.indnkeyatts
      ORDER BY k.ord
    ) AS key_columns
  FROM pg_class idx
  JOIN pg_namespace idx_ns ON idx_ns.oid = idx.relnamespace
  JOIN pg_index i ON i.indexrelid = idx.oid
  JOIN pg_class tbl ON tbl.oid = i.indrelid
  JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
  JOIN pg_am am ON am.oid = idx.relam
  WHERE idx.relname = '$ENTITY_SEQUENCE_INDEX_NAME'
    AND idx_ns.nspname = current_schema()
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM target_indexes) THEN 'missing'
  WHEN EXISTS (SELECT 1 FROM target_indexes WHERE NOT indisvalid OR NOT indisready) THEN 'invalid'
  WHEN EXISTS (
    SELECT 1
    FROM target_indexes
    WHERE table_schema = current_schema()
      AND table_name = 'operations'
      AND index_method = 'btree'
      AND NOT indisunique
      AND has_no_predicate
      AND has_no_expressions
      AND key_column_count = 4
      AND key_columns = ARRAY['user_id', 'entity_type', 'entity_id', 'server_seq']::name[]
  ) THEN 'valid'
  ELSE 'wrong'
END;
SQL
}

get_entity_sequence_index_state() {
    run_database_scalar "$(entity_sequence_index_state_sql)"
}

build_drop_entity_sequence_index_sql() {
    local db_schema

    db_schema="$(get_current_db_schema)"
    printf 'DROP INDEX CONCURRENTLY IF EXISTS %s.%s;' \
        "$(quote_sql_identifier "$db_schema")" \
        "$(quote_sql_identifier "$ENTITY_SEQUENCE_INDEX_NAME")"
}

build_create_entity_sequence_index_sql() {
    local db_schema
    local index_name
    local table_name

    db_schema="$(get_current_db_schema)"
    index_name="$(quote_sql_identifier "$ENTITY_SEQUENCE_INDEX_NAME")"
    table_name="$(quote_sql_identifier "$db_schema").$(quote_sql_identifier "operations")"

    printf 'CREATE INDEX CONCURRENTLY IF NOT EXISTS %s ON %s("user_id", "entity_type", "entity_id", "server_seq");' \
        "$index_name" \
        "$table_name"
}

require_valid_entity_sequence_index_definition() {
    local index_state

    if ! index_state="$(get_entity_sequence_index_state)"; then
        echo "ERROR: Failed to query optional $ENTITY_SEQUENCE_INDEX_NAME index state"
        return 1
    fi

    case "$index_state" in
        valid)
            return 0
            ;;
        missing)
            echo "ERROR: Optional index $ENTITY_SEQUENCE_INDEX_NAME was not created"
            return 1
            ;;
        invalid)
            echo "ERROR: Optional index $ENTITY_SEQUENCE_INDEX_NAME exists but is invalid"
            return 1
            ;;
        wrong)
            echo "ERROR: Existing index $ENTITY_SEQUENCE_INDEX_NAME has an unexpected definition"
            echo "       Drop or rename it manually before rebuilding optional indexes."
            return 1
            ;;
        *)
            echo "ERROR: Unexpected $ENTITY_SEQUENCE_INDEX_NAME index state: $index_state"
            return 1
            ;;
    esac
}

run_prisma_with_advisory_lock_retry() {
    local description="$1"
    local retry_timeout="${MIGRATION_WAIT_TIMEOUT:-900}"
    local retry_interval="${MIGRATION_RETRY_INTERVAL:-15}"
    local started_at
    local elapsed
    local output
    local exit_code

    if ! [[ "$retry_timeout" =~ ^[0-9]+$ ]] || [ "$retry_timeout" -eq 0 ]; then
        echo "ERROR: MIGRATION_WAIT_TIMEOUT must be a positive integer number of seconds"
        return 1
    fi

    if ! [[ "$retry_interval" =~ ^[0-9]+$ ]] || [ "$retry_interval" -eq 0 ]; then
        echo "ERROR: MIGRATION_RETRY_INTERVAL must be a positive integer number of seconds"
        return 1
    fi

    shift
    started_at="$(date +%s)"

    while true; do
        if output=$(run_prisma "$@" 2>&1); then
            printf '%s\n' "$output"
            return 0
        else
            exit_code=$?
        fi

        printf '%s\n' "$output"

        if ! is_prisma_advisory_lock_error "$output"; then
            return "$exit_code"
        fi

        elapsed=$(($(date +%s) - started_at))
        if [ "$elapsed" -ge "$retry_timeout" ]; then
            echo ""
            echo "ERROR: Timed out waiting for Prisma advisory migration lock after ${retry_timeout}s"
            echo "       Another supersync container may still be running migrations."
            return "$exit_code"
        fi

        echo ""
        echo "    Another Prisma migration is still holding the advisory lock while running: $description"
        echo "    Waiting ${retry_interval}s before retrying (elapsed ${elapsed}/${retry_timeout}s)..."
        sleep "$retry_interval"
    done
}

run_migrations_with_retry() {
    local exit_code

    if run_prisma_with_advisory_lock_retry "migrate deploy" migrate deploy; then
        return 0
    else
        exit_code=$?
    fi

    echo ""
    echo "==> migrate deploy failed; checking known index migration recovery..."
    recover_failed_entity_sequence_index_migration
    if [ "$KNOWN_INDEX_MIGRATION_RECOVERED" = "true" ]; then
        run_prisma_with_advisory_lock_retry "migrate deploy after known index migration recovery" migrate deploy
        return
    fi

    return "$exit_code"
}

drop_invalid_entity_sequence_index() {
    local index_state
    local drop_index_sql

    if ! index_state="$(get_entity_sequence_index_state)"; then
        echo "ERROR: Failed to query invalid $ENTITY_SEQUENCE_INDEX_NAME index state"
        return 1
    fi

    if [ "$index_state" = "invalid" ]; then
        echo "    Dropping invalid optional index $ENTITY_SEQUENCE_INDEX_NAME"
        drop_index_sql="$(build_drop_entity_sequence_index_sql)"
        run_database_execute "$drop_index_sql"
    fi
}

recover_failed_entity_sequence_index_migration() {
    local failed_migration
    local failed_migration_sql
    local migration_table_exists
    local advisory_lock_available
    local advisory_lock_sql

    KNOWN_INDEX_MIGRATION_RECOVERED=false

    if ! migration_table_exists="$(run_database_scalar "SELECT (to_regclass(format('%I._prisma_migrations', current_schema())) IS NOT NULL)::text;")"; then
        echo "ERROR: Failed to check Prisma migration table state"
        return 1
    fi
    if [ "$migration_table_exists" != "true" ]; then
        return 0
    fi

    failed_migration_sql="SELECT 1 FROM _prisma_migrations WHERE migration_name = '$ENTITY_SEQUENCE_INDEX_MIGRATION' AND finished_at IS NULL AND rolled_back_at IS NULL LIMIT 1;"
    if ! failed_migration="$(run_database_scalar "$failed_migration_sql")"; then
        echo "ERROR: Failed to check $ENTITY_SEQUENCE_INDEX_MIGRATION migration state"
        return 1
    fi
    if [ "$failed_migration" != "1" ]; then
        return 0
    fi

    # Prisma 5.x migration-engine uses this session-level advisory lock. This is
    # only a snapshot probe; migrate resolve still uses its own advisory-lock retry.
    advisory_lock_sql='SELECT CASE WHEN pg_try_advisory_lock(72707369) THEN pg_advisory_unlock(72707369)::text ELSE false::text END;'
    if ! advisory_lock_available="$(run_database_scalar "$advisory_lock_sql")"; then
        echo "ERROR: Failed to check Prisma advisory migration lock state"
        return 1
    fi
    if [ "$advisory_lock_available" != "true" ]; then
        echo ""
        echo "==> $ENTITY_SEQUENCE_INDEX_MIGRATION still appears to be active"
        echo "    Skipping automatic recovery and letting migrate deploy wait for Prisma's advisory lock."
        return 0
    fi

    echo ""
    echo "==> Recovering failed $ENTITY_SEQUENCE_INDEX_MIGRATION migration..."
    drop_invalid_entity_sequence_index
    run_prisma_with_advisory_lock_retry \
        "migrate resolve --rolled-back $ENTITY_SEQUENCE_INDEX_MIGRATION" \
        migrate resolve --rolled-back "$ENTITY_SEQUENCE_INDEX_MIGRATION"
    KNOWN_INDEX_MIGRATION_RECOVERED=true
}

warn_if_entity_sequence_index_missing() {
    local index_state

    if ! index_state="$(get_entity_sequence_index_state)"; then
        echo "ERROR: Failed to query optional $ENTITY_SEQUENCE_INDEX_NAME index state"
        return 1
    fi

    case "$index_state" in
        valid)
            return 0
            ;;
        missing)
            echo ""
            echo "WARNING: Optional index $ENTITY_SEQUENCE_INDEX_NAME is not present."
            echo "         Conflict-detection queries may be slower until it is built."
            echo "         Run RUN_POST_MIGRATION_INDEXES=true ./scripts/deploy.sh off-hours."
            ;;
        invalid)
            echo ""
            echo "WARNING: Optional index $ENTITY_SEQUENCE_INDEX_NAME exists but is invalid."
            echo "         Run RUN_POST_MIGRATION_INDEXES=true ./scripts/deploy.sh off-hours to rebuild it."
            ;;
        wrong)
            echo ""
            echo "WARNING: Optional index $ENTITY_SEQUENCE_INDEX_NAME exists with an unexpected definition."
            echo "         Drop or rename it manually before rebuilding optional indexes."
            ;;
        *)
            echo "ERROR: Unexpected $ENTITY_SEQUENCE_INDEX_NAME index state: $index_state"
            return 1
            ;;
    esac
}

run_post_migration_indexes() {
    local create_index_sql
    local index_state

    if [ "${RUN_POST_MIGRATION_INDEXES:-false}" != "true" ]; then
        echo ""
        echo "==> Skipping optional post-migration index builds"
        echo "    Set RUN_POST_MIGRATION_INDEXES=true during an off-hours deploy to build $ENTITY_SEQUENCE_INDEX_NAME"
        warn_if_entity_sequence_index_missing || echo "WARNING: Could not verify optional $ENTITY_SEQUENCE_INDEX_NAME index state; continuing."
        return 0
    fi

    echo ""
    echo "==> Building post-migration indexes..."

    drop_invalid_entity_sequence_index

    if ! index_state="$(get_entity_sequence_index_state)"; then
        echo "ERROR: Failed to query optional $ENTITY_SEQUENCE_INDEX_NAME index state"
        return 1
    fi
    if [ "$index_state" = "wrong" ]; then
        require_valid_entity_sequence_index_definition
    fi

    create_index_sql="$(build_create_entity_sequence_index_sql)"
    run_database_execute "$create_index_sql"
    require_valid_entity_sequence_index_definition
}

# Run migrations before replacing the app container. This keeps the currently
# running app available while online index builds run, and it fails the deploy
# before the app is restarted if Prisma cannot apply a migration.
POSTGRES_WAIT_TIMEOUT="${POSTGRES_WAIT_TIMEOUT:-60}"
POSTGRES_SERVICE="${POSTGRES_SERVICE-postgres}"
echo ""
if [ -n "$POSTGRES_SERVICE" ]; then
    echo "==> Ensuring $POSTGRES_SERVICE is running (wait timeout: ${POSTGRES_WAIT_TIMEOUT}s)..."
    docker compose $COMPOSE_FILES up -d --wait --wait-timeout "$POSTGRES_WAIT_TIMEOUT" "$POSTGRES_SERVICE"
else
    echo "==> Skipping compose database startup (POSTGRES_SERVICE is empty)..."
fi

echo ""
echo "==> Applying database migrations before app restart..."
run_migrations_with_retry
run_post_migration_indexes

# The migration above already ran while the old app was still serving. Force
# startup migrations off for this compose update so the replacement app cannot
# race the deploy migrator or retry long-running index work in a restart loop.
export RUN_MIGRATIONS_ON_STARTUP=false

# Start containers and wait for all health checks. Online index migrations should
# already be applied, but the longer timeout still covers slow image starts and
# no-op migration checks in the app container entrypoint.
WAIT_TIMEOUT="${DEPLOY_WAIT_TIMEOUT:-900}"
echo ""
echo "==> Starting containers (wait timeout: ${WAIT_TIMEOUT}s)..."
if [ -n "$POSTGRES_SERVICE" ]; then
    START_COMMAND=(docker compose $COMPOSE_FILES up -d --wait --wait-timeout "$WAIT_TIMEOUT")
else
    START_COMMAND=(docker compose $COMPOSE_FILES up -d --wait --wait-timeout "$WAIT_TIMEOUT" --no-deps $EXTERNAL_DB_START_SERVICES)
fi

if ! "${START_COMMAND[@]}" 2>&1; then
    echo ""
    echo "==> Container startup failed!"

    # Show status of non-running containers — best-effort under pipefail so
    # the script still reaches `exit 1` when this diagnostic block fails.
    echo "    Container status:"
    {
        docker compose $COMPOSE_FILES ps --format '{{.Name}}\t{{.Service}}\t{{.State}}' | while IFS=$'\t' read -r NAME SERVICE STATE; do
            if [ -n "$STATE" ] && [ "$STATE" != "running" ]; then
                echo "      $NAME ($STATE)"
                echo ""
                docker compose $COMPOSE_FILES logs --tail=10 "$SERVICE" 2>/dev/null || true
            fi
        done
    } || true
    exit 1
fi
echo "    All containers healthy"

# Verify HTTPS health check
echo ""
echo "==> Verifying HTTPS health check..."
for i in {1..6}; do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
        echo ""
        echo "==> Deployment successful!"
        echo "    Service is healthy at $HEALTH_URL"
        exit 0
    fi
    echo "    Waiting... (attempt $i/6)"
    sleep 5
done

echo ""
echo "==> Health check failed!"
echo "    Recent logs:"
docker compose $COMPOSE_FILES logs --tail=30
exit 1
