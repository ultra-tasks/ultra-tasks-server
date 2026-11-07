#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
image=${1:?Usage: sh scripts/update.sh IMMUTABLE_IMAGE [--local]}
case "$image" in *[!a-zA-Z0-9_./:@-]*|'') printf '%s\n' 'Invalid image reference' >&2; exit 1;; esac
case "$image" in
  *@sha256:*) revision=${image##*:}; length=64;;
  *:sha-*) revision=${image##*:sha-}; length=40;;
  *) printf '%s\n' 'Use an image digest or a full sha- revision tag' >&2; exit 1;;
esac
case "$revision" in *[!a-f0-9]*) printf '%s\n' 'Invalid immutable image revision' >&2; exit 1;; esac
test "${#revision}" = "$length"
if [ "${2:-}" = --local ]; then docker image inspect "$image" >/dev/null; else docker pull "$image"; fi
sh scripts/compose.sh stop caddy server
sh scripts/backup.sh
umask 077
config=${ULTRA_ENV_FILE:-deploy/.env}
temporary="$config.update-tmp"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
awk -v image="$image" 'BEGIN { found=0 } /^SERVER_IMAGE=/ { print "SERVER_IMAGE=" image; found=1; next } { print } END { if (!found) print "SERVER_IMAGE=" image }' "$config" > "$temporary"
mv "$temporary" "$config"
if ! sh scripts/compose.sh up -d --wait; then
  printf '%s\n' 'Update failed. Keep the service offline, inspect migrations, and restore the backup into a fresh installation if rollback is required.' >&2
  exit 1
fi
printf '%s\n' 'Updated and healthy. Confirm account login and data with a trusted client before reopening enrollment.'
