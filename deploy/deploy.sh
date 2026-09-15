#!/usr/bin/env bash
# Deploys the current main branch on the VPS. Run as root: bash /home/myasis/myasis/deploy/deploy.sh
#
# Order matters. A run launched while `tsc` is rewriting seek-bot/dist loads a
# half-written module and dies; a dashboard restart mid-run leaves that run's
# browser open on its profile, which then blocks every later run for that
# account. So: refuse new runs first (the dashboard checks the lock file),
# wait for the ones in flight to finish, and only then build and restart.
set -euo pipefail
APP=/home/myasis/myasis
LOCK=$APP/.deploying
WAIT_MINUTES=${WAIT_MINUTES:-45}

as_app() { sudo -u myasis -H bash -lc "$1"; }
# A run is `node dist/main.js` (or dist/queue.js) started by the dashboard with seek-bot as its working
# directory, so its command line never contains "seek-bot/": match the script and check where it runs.
active_runs() {
  local n=0 pid
  for pid in $(pgrep -f 'node dist/(main|queue)\.js' || true); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$APP/seek-bot" ] && n=$((n + 1))
  done
  echo "$n"
}

as_app "touch $LOCK"
trap 'as_app "rm -f $LOCK"' EXIT

for ((i = 0; i < WAIT_MINUTES * 6; i++)); do
  [ "$(active_runs)" = 0 ] && break
  [ "$i" = 0 ] && echo "waiting for $(active_runs) run(s) to finish…"
  sleep 10
done
if [ "$(active_runs)" != 0 ]; then
  echo "runs still active after $WAIT_MINUTES minutes; not deploying"
  exit 1
fi

as_app "cd $APP && git pull -q origin main && git log --oneline -1"
as_app "cd $APP/seek-bot && npm run build 2>&1 | tail -1"
as_app "cd $APP/dashboard && npm run build 2>&1 | tail -1"
# The dashboard closes its browsers on SIGINT; pm2 waits for it before forcing.
as_app "pm2 restart myasis-dashboard --update-env --kill-timeout 8000 > /dev/null && echo restarted"
