#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
if [ ! -f deploy/.env ]; then
  docker run --rm --entrypoint node ultra-tasks-server:dev scripts/create-dev-env.cjs > deploy/.env.tmp
  mv deploy/.env.tmp deploy/.env
fi
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.dev.yaml up -d --wait
printf '%s\n' 'Account dashboard: http://localhost:1900/account' 'Development mail: http://localhost:8025'
