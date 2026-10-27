#!/usr/bin/env bash
# Deploys the current main branch on the VPS. Run as root: bash /home/myasis/myasis/deploy/deploy.sh
#
# Order matters. A run launched while `tsc` is rewriting seek-bot/dist loads a
# half-written module and dies; a dashboard restart mid-run leaves that run's
# browser open on its profile, which then blocks every later run for that
# account. So: refuse new runs first (the dashboard checks the lock file),
# wait for the ones in flight to finish, and only then build and restart.
set -euo pipefail
# Serialize whole releases, including builds/tests. The .deploying file only
# blocks job starts; it cannot keep two deploys from clearing the same dist.
exec 9>/run/lock/myasis-deploy.lock
if ! flock -n 9; then
  echo 'another deployment is already running; not changing the live checkout'
  exit 1
fi
APP=/home/myasis/myasis
LOCK=$APP/.deploying
WAIT_MINUTES=${WAIT_MINUTES:-45}

as_app() { sudo -u myasis -H bash -lc "$1"; }
# A run is `node dist/main.js` (or dist/queue.js) started by the dashboard with seek-bot as its working
# directory, so its command line never contains "seek-bot/": match the script and check where it runs.
active_runs() {
  local n=0 pid
  for pid in $(pgrep -f 'node dist/(main|queue|browser-benchmark)\.js' || true); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$APP/seek-bot" ] && n=$((n + 1))
  done
  # The diagnostic coordinator owns a profile between its child trials too.
  for pid in $(pgrep -f 'scripts/benchmark-browser\.(mjs|mts)' || true); do
    case "$(readlink "/proc/$pid/cwd" 2>/dev/null)" in
      "$APP/seek-bot"|"$APP/dashboard") n=$((n + 1));;
    esac
  done
  for pid in $(pgrep -f 'node .*cli\.js (research|scan-site|audit-site|ai-visibility)' || true); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$APP/market-scout" ] && n=$((n + 1))
  done
  local marketing
  marketing=0
  if [ -f "$APP/dashboard/scripts/marketing-active.mts" ]; then
    marketing=$(as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx scripts/marketing-active.mts")
  fi
  [[ "$marketing" =~ ^[0-9]+$ ]] || marketing=1
  n=$((n + marketing))
  echo "$n"
}

# Run only small checks, in one bounded phase after builds.
as_app "cd $APP && git fetch -q origin main"
REPLAY_REQUIRED=0
if ! as_app "cd $APP && git diff --quiet HEAD origin/main -- seek-bot"; then
  REPLAY_REQUIRED=1
fi

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
# Dependencies exactly as the lock file says, never rewriting it. A server whose
# npm differs from the one that wrote the lock would otherwise leave a modified
# package-lock.json behind, and the next pull refuses to overwrite it — which is
# how a deploy once stopped at `git pull`. And a release that adds a package
# cannot build without this step.
as_app "set -o pipefail; cd $APP/seek-bot && npm ci --no-audit --no-fund 2>&1 | tail -1"
as_app "set -o pipefail; cd $APP/dashboard && npm ci --no-audit --no-fund 2>&1 | tail -1"
as_app "set -o pipefail; cd $APP/market-scout && npm ci --no-audit --no-fund 2>&1 | tail -1"
as_app "set -o pipefail; cd $APP/seek-bot && npm run build 2>&1 | tail -1"
as_app "set -o pipefail; cd $APP/dashboard && npm run build 2>&1 | tail -1"
as_app "cd $APP/market-scout && npm exec tsc -- -p ."
# At most 58 seconds to finish, then 2 seconds before forced termination.
# A failed or timed-out check stops the release; it never counts as a pass.
echo 'Running limited deployment checks (60-second maximum)'
FORCE_FLAG=0
if [ "${FORCE_DEPLOY:-}" = 1 ]; then FORCE_FLAG=1; fi
as_app "cd $APP && FORCE_DEPLOY=$FORCE_FLAG timeout --signal=TERM --kill-after=2s 58s bash deploy/smoke-check.sh $REPLAY_REQUIRED"
# Apply idempotent schema upgrades before the new dashboard and its scheduler
# start querying new columns. A migration failure leaves the old process up.
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx scripts/migrate-db.mts"
# Cron invokes Bash explicitly, so a Git checkout cannot disable backups by
# resetting maintenance.sh's execute bit. Keep installed scheduling in sync.
install -m 644 "$APP/deploy/myasis.cron" /etc/cron.d/myasis
bash "$APP/deploy/public-site.sh"
# pm2 remembers the environment a process was started with, and --update-env only
# adds what the calling shell has. So the run limit is changed by giving it to this
# script (MAX_CONCURRENT_RUNS=3 bash deploy.sh): it is handed to pm2 on the restart
# and saved, and later deploys keep it without being told again.
RUN_LIMIT=""
if [[ "${MAX_CONCURRENT_RUNS:-}" =~ ^[1-9][0-9]?$ ]]; then RUN_LIMIT="MAX_CONCURRENT_RUNS=$MAX_CONCURRENT_RUNS "; fi
# The dashboard closes its browsers on SIGINT; pm2 waits for it before forcing.
as_app "${RUN_LIMIT}PUBLIC_SITE_URL=http://127.0.0.1:5191 pm2 restart myasis-dashboard --update-env --kill-timeout 30000 > /dev/null && pm2 save > /dev/null && echo restarted"
as_app "cd $APP && pm2 startOrReload ecosystem.config.cjs --only market-scout --update-env > /dev/null && pm2 save > /dev/null && echo 'market research restarted'"
# Fail the release if the public bridge is missing or serves a broken page.
for attempt in {1..30}; do
  if curl -fsS -D /tmp/myasis-public-headers -o /dev/null http://127.0.0.1:5180/ && grep -qi '^x-public-site: nextjs' /tmp/myasis-public-headers; then
    echo 'Next.js public website verified'
    break
  fi
  if [ "$attempt" = 30 ]; then echo 'public website bridge failed health check' >&2; exit 1; fi
  sleep 1
done
