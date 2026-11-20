#!/bin/sh
set -eu
umask 077

# Run only inside the PostgreSQL container. All access uses its local socket.
db() { psql -X -v ON_ERROR_STOP=1 -U ultra -d ultra "$@"; }
directory=$(db -Atc 'SHOW data_directory')
state="$directory/.ultra-restore-listen.sql"
releasing="$state.releasing"
refuse() { printf '%s\n' "$1" >&2; exit 1; }

assert_locked() {
  [ -s "$state" ] && [ -z "$(db -Atc 'SHOW listen_addresses')" ] ||
    refuse 'Restore refused: PostgreSQL is not in local-only recovery mode.'
}

case "${1:-}" in
  lock)
    [ ! -e "$releasing" ] || refuse 'A previous PostgreSQL release must be completed first.'
    if [ ! -e "$state" ]; then
      # Preserve an existing ALTER SYSTEM override, or the lack of one. Keep
      # the original setting across a failed import and a PostgreSQL restart.
      tmp=$(mktemp "$state.XXXXXX")
      trap 'rm -f "$tmp"' EXIT HUP INT TERM
      db -Atc "SELECT CASE
        WHEN sourcefile = current_setting('data_directory') || '/postgresql.auto.conf'
          THEN format('ALTER SYSTEM SET listen_addresses TO %L;', setting)
        ELSE 'ALTER SYSTEM RESET listen_addresses;'
        END FROM pg_settings WHERE name = 'listen_addresses'" > "$tmp"
      test -s "$tmp"
      ln "$tmp" "$state" 2>/dev/null || test -s "$state"
      rm -f "$tmp"
    fi
    test -s "$state"
    db -c "ALTER SYSTEM SET listen_addresses TO ''"
    ;;
  check)
    assert_locked
    ;;
  phase)
    if [ -s "$releasing" ]; then
      printf '%s\n' releasing
    else
      assert_locked
      printf '%s\n' locked
    fi
    ;;
  release)
    if [ ! -s "$releasing" ]; then
      assert_locked
      mv "$state" "$releasing"
    fi
    db -f "$releasing"
    ;;
  clear)
    rm -f "$releasing"
    ;;
  *) refuse 'Unknown PostgreSQL recovery operation.' ;;
esac
