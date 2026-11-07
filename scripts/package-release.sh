#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
case "$revision" in *[!a-f0-9]*) exit 1;; esac
test "${#revision}" = 40
mkdir -p .tmp/releases
temporary=$(mktemp -d .tmp/release.XXXXXX)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
# Archive tracked source only: never include operator configuration or backups.
git archive HEAD deploy docs README.md SOURCE.md LICENSE LICENSING.md LICENSES \
  scripts/compose.sh scripts/setup.sh scripts/install.sh scripts/update.sh \
  scripts/backup.sh scripts/restore.sh scripts/diagnostics.sh | tar -x -C "$temporary"
sed "s|^SERVER_IMAGE=.*|SERVER_IMAGE=ghcr.io/ultra-tasks/ultra-tasks-server:sha-$revision|" \
  "$temporary/deploy/env.example" > "$temporary/deploy/env.example.pinned"
mv "$temporary/deploy/env.example.pinned" "$temporary/deploy/env.example"
printf '%s\n' "$revision" > "$temporary/REVISION"
target=".tmp/releases/ultra-tasks-server-compose-$revision.tar.gz"
tar -czf "$target" -C "$temporary" .
(cd .tmp/releases && sha256sum "${target##*/}") > "$target.sha256"
printf '%s\n' "Installation bundle: $target"
