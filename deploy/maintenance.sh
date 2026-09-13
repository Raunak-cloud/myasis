#!/usr/bin/env bash
# Nightly housekeeping for a Myasis VPS. Installed by setup-vps.sh as
# /etc/cron.d/myasis (root, 03:15 server time), safe to run by hand any time:
#
#   1. Backs up everything that cannot be regenerated — the Postgres database
#      and each account's résumé/knowledge files — to /var/backups/myasis,
#      keeping 14 days locally.
#   2. Copies the night's backup off the box when an rclone remote named
#      "backup" exists (rclone config; any S3/R2/B2/Drive works), keeping 30
#      days there. No remote configured means backups are local only, and the
#      log says so.
#   3. Clears Chrome's caches for accounts with no run in progress. Chrome
#      recreates them; sign-ins, cookies and history are untouched.
#   4. Drops agent traces older than 30 days. Needs-attention screenshots
#      come from these, and nothing that old is still on anyone's list.
#
# Chrome profiles themselves are deliberately not backed up: they are
# hundreds of MB each and hold only a SEEK sign-in the person can redo.
set -euo pipefail

APP_DIR="${MYASIS_DIR:-/home/myasis/myasis}"
USERS_DIR="$APP_DIR/seek-bot/data/users"
BACKUP_DIR="${MYASIS_BACKUP_DIR:-/var/backups/myasis}"
DB_NAME="${MYASIS_DB:-myasis}"
REMOTE="${MYASIS_BACKUP_REMOTE:-backup}"
KEEP_LOCAL_DAYS=14
KEEP_REMOTE_DAYS=30
KEEP_TRACE_DAYS=30
STAMP="$(date +%Y%m%d-%H%M)"

log() { echo "[$(date '+%F %T')] $*"; }

# ---- 1. backups ---------------------------------------------------------
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

db_file="$BACKUP_DIR/db-$STAMP.dump"
# Custom format: compressed, and pg_restore can pick single tables from it.
sudo -u postgres pg_dump -Fc "$DB_NAME" > "$db_file"
log "database → $db_file ($(du -h "$db_file" | cut -f1))"

files_file="$BACKUP_DIR/files-$STAMP.tar.gz"
if [ -d "$USERS_DIR" ]; then
  # Only what userdata.ts calls canonical in the directory; everything else
  # there is re-exported from Postgres before each run.
  (cd "$USERS_DIR" && find . -maxdepth 2 \( -name resumes -o -name knowledge -o -name queue.json \) -print0 \
    | tar --null -czf "$files_file" --files-from - 2>/dev/null) || : > "$files_file"
  log "account files → $files_file ($(du -h "$files_file" | cut -f1))"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f -mtime +"$KEEP_LOCAL_DAYS" -delete
log "local backups kept: $(ls "$BACKUP_DIR" | wc -l) files, $(du -sh "$BACKUP_DIR" | cut -f1)"

# ---- 2. off-box copy ----------------------------------------------------
if command -v rclone >/dev/null && rclone listremotes 2>/dev/null | grep -qx "$REMOTE:"; then
  rclone copy "$db_file" "$REMOTE:myasis/" --quiet
  [ -f "${files_file:-}" ] && rclone copy "$files_file" "$REMOTE:myasis/" --quiet
  rclone delete "$REMOTE:myasis/" --min-age "${KEEP_REMOTE_DAYS}d" --quiet || true
  log "copied off-box to $REMOTE:myasis/"
else
  log "WARNING: no rclone remote '$REMOTE' — backups are on this machine only"
fi

# ---- 3. Chrome caches ---------------------------------------------------
freed=0
for profile in "$USERS_DIR"/*/chrome; do
  [ -d "$profile" ] || continue
  # Chrome holds this lock for as long as it runs; a profile with a run in
  # progress is left alone and picked up the next night.
  if [ -e "$profile/SingletonLock" ] || [ -L "$profile/SingletonLock" ]; then
    log "skip $(basename "$(dirname "$profile")"): Chrome is running"
    continue
  fi
  for cache in "$profile/Default/Cache" "$profile/Default/Code Cache" "$profile/Default/GPUCache" \
               "$profile/GrShaderCache" "$profile/ShaderCache" "$profile/GraphiteDawnCache"; do
    [ -d "$cache" ] || continue
    freed=$(( freed + $(du -sm "$cache" | cut -f1) ))
    rm -rf "$cache"
  done
done
log "chrome caches cleared: ${freed}MB"

# ---- 4. old traces ------------------------------------------------------
removed=0
for traces in "$USERS_DIR"/*/traces; do
  [ -d "$traces" ] || continue
  n=$(find "$traces" -type f -mtime +"$KEEP_TRACE_DAYS" -print -delete | wc -l)
  removed=$(( removed + n ))
done
log "traces older than ${KEEP_TRACE_DAYS} days removed: $removed"

log "accounts directory now $(du -sh "$USERS_DIR" 2>/dev/null | cut -f1)"
