#!/usr/bin/env bash
# Installs or refreshes the database that turns a visitor's address into a place.
#
# DB-IP publishes its free "IP to City Lite" database monthly, with no account or
# key, under CC BY 4.0 (the Visitors view carries the attribution it asks for).
# Run as root: bash /home/myasis/myasis/deploy/geoip-update.sh — and monthly from
# cron; a month already installed is not fetched again. The dashboard watches the
# file and reloads it, so no restart is needed.
#
# MaxMind's GeoLite2-City is more accurate and also free, but needs an account
# and a licence key; it drops into the same GEOIP_DB path if you switch later.
set -euo pipefail
DIR=${GEOIP_DIR:-/home/myasis/geoip}
TARGET=$DIR/dbip-city-lite.mmdb
mkdir -p "$DIR"

for month in "$(date -u +%Y-%m)" "$(date -u -d 'last month' +%Y-%m)"; do
  if [ -f "$DIR/.version" ] && [ "$(cat "$DIR/.version")" = "$month" ]; then
    echo "already have $month"
    exit 0
  fi
  url="https://download.db-ip.com/free/dbip-city-lite-$month.mmdb.gz"
  if curl -fsSL --retry 3 -o "$TARGET.gz.tmp" "$url"; then
    gunzip -c "$TARGET.gz.tmp" > "$TARGET.tmp"
    rm -f "$TARGET.gz.tmp"
    mv -f "$TARGET.tmp" "$TARGET"
    echo "$month" > "$DIR/.version"
    chown -R myasis:myasis "$DIR"
    echo "installed $month ($(du -h "$TARGET" | cut -f1)) at $TARGET"
    exit 0
  fi
  echo "no release for $month yet"
done
echo "could not download a database" >&2
exit 1
