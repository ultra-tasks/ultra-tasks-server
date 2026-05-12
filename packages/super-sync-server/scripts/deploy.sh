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

# Pull latest code (scripts, docker-compose.yml, etc.)
echo "==> Pulling latest code..."
git pull --ff-only || { echo "WARNING: git pull failed — continuing with current files"; }
echo ""

# Load GHCR credentials from .env (for private images)
if [ -f ".env" ]; then
    GHCR_VARS=$(grep -E '^(GHCR_USER|GHCR_TOKEN)=' ".env" 2>/dev/null | xargs || true)
    if [ -n "$GHCR_VARS" ]; then
        export $GHCR_VARS
    fi
fi

# Login to GHCR if credentials provided
if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
    echo "==> Logging in to GHCR..."
    echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
    echo ""
fi

# Check if monitoring compose exists and include it
COMPOSE_FILES="-f docker-compose.yml"
if [ -f "docker-compose.monitoring.yml" ]; then
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.monitoring.yml"
fi

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

# Run migrations before replacing the app container. This keeps the currently
# running app available while online index builds run, and it fails the deploy
# before the app is restarted if Prisma cannot apply a migration.
POSTGRES_WAIT_TIMEOUT="${POSTGRES_WAIT_TIMEOUT:-60}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
echo ""
if [ -n "$POSTGRES_SERVICE" ]; then
    echo "==> Ensuring $POSTGRES_SERVICE is running (wait timeout: ${POSTGRES_WAIT_TIMEOUT}s)..."
    docker compose $COMPOSE_FILES up -d --wait --wait-timeout "$POSTGRES_WAIT_TIMEOUT" "$POSTGRES_SERVICE"
else
    echo "==> Skipping compose database startup (POSTGRES_SERVICE is empty)..."
fi

echo ""
echo "==> Applying database migrations before app restart..."
docker compose $COMPOSE_FILES run --rm --no-deps supersync npx prisma migrate deploy

# The migration above already ran while the old app was still serving. Disable
# startup migrations for this compose update so the replacement app starts
# immediately after image creation. Direct docker-compose users keep the image
# default unless they also set RUN_MIGRATIONS_ON_STARTUP=false.
export RUN_MIGRATIONS_ON_STARTUP="${RUN_MIGRATIONS_ON_STARTUP:-false}"

# Start containers and wait for all health checks. Online index migrations should
# already be applied, but the longer timeout still covers slow image starts and
# no-op migration checks in the app container entrypoint.
WAIT_TIMEOUT="${DEPLOY_WAIT_TIMEOUT:-900}"
echo ""
echo "==> Starting containers (wait timeout: ${WAIT_TIMEOUT}s)..."
START_STATUS=0
if [ -n "$POSTGRES_SERVICE" ]; then
    START_RESULT=$(docker compose $COMPOSE_FILES up -d --wait --wait-timeout "$WAIT_TIMEOUT" 2>&1) || START_STATUS=$?
else
    START_RESULT=$(docker compose $COMPOSE_FILES up -d --wait --wait-timeout "$WAIT_TIMEOUT" --no-deps supersync caddy 2>&1) || START_STATUS=$?
fi
if [ "${START_STATUS:-0}" -ne 0 ]; then
    echo "$START_RESULT"
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
echo "$START_RESULT"
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
