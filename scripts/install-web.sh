#!/bin/sh
# Install a released Ultra Tasks web bundle so it is served at the origin root.
#
#   sh scripts/install-web.sh ultra-tasks-web-0.3.0.tar.gz [--keep-days 30]
#
# The archive and its ultra-tasks-web-<version>.tar.gz.sha256 file come from the
# application release. The bundle is unpacked into <web directory>/<version>/ and
# the "current" symlink is switched to it. Rolling back is pointing "current" at
# an older version directory. Hashed files from the previous release are carried
# forward for --keep-days so a browser tab that has not reloaded can still fetch
# a lazy chunk. Nothing here touches the database or the server container.
set -eu
cd "$(dirname "$0")/.."

archive=${1:-}
keep_days=30
if [ -z "$archive" ]; then
  printf '%s\n' 'Usage: sh scripts/install-web.sh ultra-tasks-web-VERSION.tar.gz [--keep-days N]' >&2
  exit 1
fi
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-days) keep_days=${2:-}; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
case "$keep_days" in ''|*[!0-9]*) printf '%s\n' '--keep-days needs a whole number.' >&2; exit 1 ;; esac

env_file=${ULTRA_ENV_FILE:-deploy/.env}
web_dir=${ULTRA_WEB_DIRECTORY:-}
if [ -z "$web_dir" ] && [ -f "$env_file" ]; then
  web_dir=$(sed -n 's/^ULTRA_WEB_DIRECTORY=//p' "$env_file" | tail -n 1 | tr -d '\r')
fi
web_dir=${web_dir:-./web}
# Relative paths in deploy/.env are relative to deploy/, as Compose reads them.
case "$web_dir" in /*) ;; *) web_dir=deploy/$web_dir ;; esac

[ -f "$archive" ] || { printf 'Archive not found: %s\n' "$archive" >&2; exit 1; }
[ -f "$archive.sha256" ] || { printf 'Checksum file not found: %s.sha256\n' "$archive" >&2; exit 1; }
name=$(basename "$archive")
# The checksum file must name this exact archive and match its content.
read -r expected listed < "$archive.sha256" || true
listed=${listed#\*}
actual=$(sha256sum "$archive" | cut -d' ' -f1)
if [ "$listed" != "$name" ] || [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  printf '%s\n' 'Checksum mismatch. Nothing was installed.' >&2
  exit 1
fi

version=${name#ultra-tasks-web-}
version=${version%.tar.gz}
case "$version" in
  ''|"$name"|*[!0-9A-Za-z._-]*|.*) printf '%s\n' 'The archive must be named ultra-tasks-web-VERSION.tar.gz.' >&2; exit 1 ;;
esac

# Refuse archives that could write outside their own directory.
if tar -tzf "$archive" | grep -qE '(^/|(^|/)\.\.(/|$))'; then
  printf '%s\n' 'The archive contains unsafe paths. Nothing was installed.' >&2
  exit 1
fi

mkdir -p "$web_dir"
[ ! -e "$web_dir/$version" ] || { printf 'Version %s is already installed.\n' "$version" >&2; exit 1; }
staging=$(mktemp -d "$web_dir/.incoming.XXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
tar -xzf "$archive" -C "$staging" --no-same-owner
[ -f "$staging/index.html" ] && [ -f "$staging/ngsw.json" ] \
  || { printf '%s\n' 'The archive is not a web bundle (index.html or ngsw.json is missing).' >&2; exit 1; }

previous=
if [ -L "$web_dir/current" ]; then previous=$(readlink "$web_dir/current"); fi
if [ -n "$previous" ] && [ -d "$web_dir/$previous" ]; then
  # Carry forward recent hashed files the new release no longer contains.
  (cd "$web_dir/$previous" && find . -type f \( -name 'chunk-*.js' -o -name 'main-*.js' \
    -o -name 'polyfills-*.js' -o -name 'styles-*.css' -o -name 'worker-*.js' \
    -o -path './media/*' \) -mtime -"$keep_days" -print) | while IFS= read -r file; do
    if [ ! -e "$staging/$file" ]; then
      mkdir -p "$staging/$(dirname "$file")"
      cp -p "$web_dir/$previous/$file" "$staging/$file"
    fi
  done
fi

chmod -R a+rX "$staging"
mv "$staging" "$web_dir/$version"
trap - EXIT HUP INT TERM
ln -s "$version" "$web_dir/.current.$$"
mv -T "$web_dir/.current.$$" "$web_dir/current"

# Drop old version directories, never the one now in use or the one before it.
find "$web_dir" -mindepth 1 -maxdepth 1 -type d ! -name 'current' ! -name ".*" \
  ! -name "$version" ${previous:+! -name "$previous"} -mtime +"$keep_days" -exec rm -rf {} +

printf 'Installed web bundle %s at %s/current%s\n' "$version" "$web_dir" \
  "${previous:+ (previous: $previous)}"
