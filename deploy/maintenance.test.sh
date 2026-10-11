#!/usr/bin/env bash
# Exercise backup failure paths with fake database/remote commands and real tar.
set -euo pipefail
SCRIPT=$(cd "$(dirname "$0")" && pwd)/maintenance.sh
FIXTURE=$(mktemp -d /tmp/myasis-maintenance-test.XXXXXXXX)
case "$FIXTURE" in /tmp/myasis-maintenance-test.*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/bin" "$FIXTURE/app/seek-bot/data/users/fixture/resumes"
printf 'fixture resume\n' > "$FIXTURE/app/seek-bot/data/users/fixture/resumes/cv.txt"
cat > "$FIXTURE/bin/sudo" <<'STUB'
#!/bin/bash
shift 2
exec "$@"
STUB
cat > "$FIXTURE/bin/pg_dump" <<'STUB'
#!/bin/bash
[ "${FAIL_DUMP:-0}" = 0 ] || exit 1
printf 'fixture database\n'
STUB
cat > "$FIXTURE/bin/pg_restore" <<'STUB'
#!/bin/bash
grep -q 'fixture database' "$2"
STUB
cat > "$FIXTURE/bin/rclone" <<'STUB'
#!/bin/bash
if [ "$1" = listremotes ]; then printf 'backup:\n'; exit 0; fi
[ "${FAIL_REMOTE:-0}" = 0 ] || exit 1
STUB
chmod 755 "$FIXTURE/bin/"*

run_backup() {
  PATH="$FIXTURE/bin:$PATH" MYASIS_DIR="$FIXTURE/app" MYASIS_BACKUP_DIR="$FIXTURE/$1" MYASIS_BACKUP_ONLY=1 \
    bash "$SCRIPT" > "$FIXTURE/$1.log" 2>&1
}
fail() { echo "FAIL: $*" >&2; exit 1; }

run_backup success
test "$(find "$FIXTURE/success" -name '*.dump' | wc -l)" = 1 || fail 'database archive missing'
test "$(find "$FIXTURE/success" -name '*.tar.gz' | wc -l)" = 1 || fail 'file archive missing'
test "$(stat -c %a "$FIXTURE/success/"*.dump)" = 600 || fail 'database permissions not private'
tar -tzf "$FIXTURE/success/"*.tar.gz | grep -q '/resumes/cv.txt' || fail 'resume not archived'
grep -q 'copied off-box' "$FIXTURE/success.log" || fail 'remote copy not completed'

if FAIL_DUMP=1 run_backup failed_dump; then fail 'database failure ignored'; fi
test -z "$(find "$FIXTURE/failed_dump" -type f)" || fail 'failed database published'

cat > "$FIXTURE/bin/tar" <<'STUB'
#!/bin/bash
exit 2
STUB
chmod 755 "$FIXTURE/bin/tar"
if run_backup failed_tar; then fail 'archive failure ignored'; fi
test -z "$(find "$FIXTURE/failed_tar" -name '*.tar.gz*')" || fail 'failed archive published'
if grep -q 'account files →' "$FIXTURE/failed_tar.log"; then fail 'failed archive reported successful'; fi
rm -- "$FIXTURE/bin/tar"

if FAIL_REMOTE=1 run_backup failed_remote; then fail 'remote failure ignored'; fi
test "$(find "$FIXTURE/failed_remote" -name '*.dump' | wc -l)" = 1 || fail 'local backup lost after remote failure'
if grep -q 'copied off-box' "$FIXTURE/failed_remote.log"; then fail 'remote failure reported successful'; fi
test -z "$(find "$FIXTURE" -name '*.part-*')" || fail 'partial archives left behind'
echo 'PASS: complete private backups; database, archive and remote-copy errors stop the job without publishing partial files'
