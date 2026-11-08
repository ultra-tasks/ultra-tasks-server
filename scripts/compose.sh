#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
env_file=${ULTRA_ENV_FILE:-deploy/.env}
if [ "${ULTRA_DEVELOPMENT:-false}" = true ]; then
  exec docker compose --env-file "$env_file" -f deploy/compose.yaml -f deploy/compose.dev.yaml "$@"
fi
external_proxy=${ULTRA_EXTERNAL_PROXY:-}
if [ -z "$external_proxy" ] && [ -f "$env_file" ]; then
  external_proxy=$(sed -n 's/^ULTRA_EXTERNAL_PROXY=//p' "$env_file" | tail -n 1 | tr -d '\r')
fi
case "${external_proxy:-false}" in
  true) exec docker compose --env-file "$env_file" -f deploy/compose.yaml -f deploy/compose.proxy.yaml "$@" ;;
  false) exec docker compose --env-file "$env_file" -f deploy/compose.yaml "$@" ;;
  *) printf '%s\n' 'ULTRA_EXTERNAL_PROXY must be true or false.' >&2; exit 1 ;;
esac
