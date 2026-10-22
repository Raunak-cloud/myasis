#!/usr/bin/env bash
# Called by deploy.sh after the backend's checks and migration, before restart.
# Each running Next.js release keeps its own build files while the next one builds.
set -euo pipefail
APP=${APP_DIR:-/home/myasis/myasis}
as_app() { sudo -u myasis -H bash -lc "$1"; }
as_app "cd $APP/public-site && npm ci --no-audit --no-fund && npm run build && npm test"
release="$APP/public-site/.releases/$(date -u +%Y%m%dT%H%M%S)-$(git -C "$APP" rev-parse --short HEAD 2>/dev/null || as_app "cd $APP && git rev-parse --short HEAD")"
as_app "mkdir -p '$release' && cp -a '$APP/public-site/.next/standalone/.' '$release/'"
previous=$(readlink "$APP/public-site/.current" || true)
as_app "ln -s '$release' '$APP/public-site/.current.new' && mv -Tf '$APP/public-site/.current.new' '$APP/public-site/.current'"
restore_release() {
  if [ -n "$previous" ]; then
    as_app "ln -s '$previous' '$APP/public-site/.current.rollback' && mv -Tf '$APP/public-site/.current.rollback' '$APP/public-site/.current'"
    as_app "cd $APP && pm2 startOrReload ecosystem.config.cjs --only owtomate-public-site --update-env >/dev/null"
  else
    as_app "pm2 stop owtomate-public-site >/dev/null" || true
  fi
}
as_app "cd $APP && pm2 startOrReload ecosystem.config.cjs --only owtomate-public-site --update-env >/dev/null"
# The old backend may still be serving during first activation. Check a built
# asset here; the new content bridge is checked after the dashboard restarts.
asset=$(as_app "cd $APP/public-site && find .next/static -type f -name '*.js' | head -1" | sed 's@^\.next/static/@@')
for attempt in {1..30}; do
  if curl -fsS -o /dev/null "http://127.0.0.1:5191/_next/static/$asset"; then break; fi
  if [ "$attempt" = 30 ]; then restore_release; echo 'Next.js failed its startup check' >&2; exit 1; fi
  sleep 1
done
if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  # Preserve the live domain, TLS and proxy settings. Only allow Next.js's nonce
  # policy to override the existing default; never weaken dashboard responses.
  candidate=$(mktemp /etc/caddy/Caddyfile.public-site.XXXXXX)
  sed -E 's/^([[:space:]]*)Content-Security-Policy[[:space:]]/\1?Content-Security-Policy /' /etc/caddy/Caddyfile > "$candidate"
  if ! grep -qE '^[[:space:]]*\?Content-Security-Policy ' "$candidate"; then
    rm -f "$candidate"; restore_release; echo 'Could not locate the public CSP directive' >&2; exit 1
  fi
  if ! cmp -s "$candidate" /etc/caddy/Caddyfile; then
    if ! caddy validate --config "$candidate" --adapter caddyfile; then rm -f "$candidate"; restore_release; exit 1; fi
    cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-public-site
    install -m 644 "$candidate" /etc/caddy/Caddyfile
    if ! systemctl reload caddy; then
      cp -a /etc/caddy/Caddyfile.before-public-site /etc/caddy/Caddyfile
      systemctl reload caddy
      restore_release
      rm -f "$candidate"
      exit 1
    fi
  fi
  rm -f "$candidate"
fi
as_app "pm2 save >/dev/null"
echo 'public website ready'
