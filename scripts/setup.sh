#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
origin=${1:?Usage: sh scripts/setup.sh HTTPS_ORIGIN [SERVER_IMAGE]}
image=${2:-ultra-tasks-server:local}
umask 077
if [ -e deploy/.env ]; then printf '%s\n' 'Configuration already exists; it was not replaced.' >&2; exit 1; fi
docker run --rm --entrypoint node "$image" scripts/create-config.cjs "$origin" "$image" > deploy/.env.tmp
mv deploy/.env.tmp deploy/.env
printf '%s\n' 'Created deploy/.env with persistent operator secrets and closed enrollment. Configure SMTP and operator documents, then run scripts/install.sh.'
