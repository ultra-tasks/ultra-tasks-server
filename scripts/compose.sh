#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${ULTRA_DEVELOPMENT:-false}" = true ]; then
  exec docker compose --env-file "${ULTRA_ENV_FILE:-deploy/.env}" -f deploy/compose.yaml -f deploy/compose.dev.yaml "$@"
fi
exec docker compose --env-file "${ULTRA_ENV_FILE:-deploy/.env}" -f deploy/compose.yaml "$@"
