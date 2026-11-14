#!/usr/bin/env bash
# Deploys the current main branch on the VPS. Run as root: bash /home/myasis/myasis/deploy/deploy.sh
#
# Order matters. A run launched while `tsc` is rewriting seek-bot/dist loads a
# half-written module and dies; a dashboard restart mid-run leaves that run's
# browser open on its profile, which then blocks every later run for that
# account. So: refuse new runs first (the dashboard checks the lock file),
# wait for the ones in flight to finish, and only then build and restart.
set -euo pipefail
# Operators may allow slow hosts more verification time, but may neither skip
# checks nor leave them unbounded. Validate before taking the deployment gate.
CHECK_TIMEOUT_SECONDS=${DEPLOY_CHECK_TIMEOUT_SECONDS:-240}
if ! [[ "$CHECK_TIMEOUT_SECONDS" =~ ^[0-9]{3,4}$ ]] || (( CHECK_TIMEOUT_SECONDS < 240 || CHECK_TIMEOUT_SECONDS > 1200 )); then
  echo 'DEPLOY_CHECK_TIMEOUT_SECONDS must be between 240 and 1200' >&2
  exit 2
fi
CHECK_SOFT_TIMEOUT_SECONDS=$((CHECK_TIMEOUT_SECONDS - 2))
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
OPERATOR_HOLD_REQUIRED=0
OPERATOR_HOLD_RELEASE_READY=0
if [ -n "${OPERATOR_HOLD_PLAN:-}" ]; then OPERATOR_HOLD_REQUIRED=1; fi

as_app() { sudo -u myasis -H bash -lc "$1"; }
# A run is `node dist/main.js` (or dist/queue.js) started by the dashboard with seek-bot as its working
# directory, so its command line never contains "seek-bot/": match the script and check where it runs.
active_runs() {
  local n=0 pid
  for pid in $(pgrep -f 'node (dist/(main|queue|browser-benchmark)\.js|/opt/owtomate-repair-releases/[a-f0-9-]+/seek-bot/dist/main\.js)' || true); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$APP/seek-bot" ] && n=$((n + 1))
  done
  # The diagnostic coordinator owns a profile between its child trials too.
  for pid in $(pgrep -f 'scripts/benchmark-browser\.(mjs|mts)' || true); do
    case "$(readlink "/proc/$pid/cwd" 2>/dev/null)" in
      "$APP/seek-bot"|"$APP/dashboard") n=$((n + 1));;
    esac
  done
  # Admin form tests use the production applying agent in an isolated worker.
  for pid in $(pgrep -f 'form-lab/worker\.mjs' || true); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$APP" ] && n=$((n + 1))
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

as_app "touch $LOCK"
cleanup_deployment() {
  local result=$?
  if [ "$OPERATOR_HOLD_REQUIRED" = 1 ] && [ "$OPERATOR_HOLD_RELEASE_READY" != 1 ]; then
    as_app "printf '%s\n' operator-safety-hold-required > $LOCK" || true
    echo 'Operator safety release incomplete; deployment gate remains closed. Resolve the explicit hold plan and rerun the reviewed release.' >&2
  else
    as_app "rm -f $LOCK"
  fi
  return "$result"
}
trap cleanup_deployment EXIT
as_app "printf '%s\n' draining > $LOCK"
# Run only small checks, in one bounded phase after builds.
as_app "cd $APP && git fetch -q origin main"

for ((i = 0; i < WAIT_MINUTES * 6; i++)); do
  [ "$(active_runs)" = 0 ] && break
  [ "$i" = 0 ] && echo "waiting for $(active_runs) run(s) to finish…"
  sleep 10
done
if [ "$(active_runs)" != 0 ]; then
  echo "runs still active after $WAIT_MINUTES minutes; not deploying"
  exit 1
fi
as_app "printf '%s\n' building > $LOCK"
# A crawler never shares an application browser, but must not import dist while
# the build is replacing it. Its leased index tasks recover after interruption.
as_app "pm2 stop owtomate-job-index >/dev/null 2>&1 || true"

# A deployment may wait while new commits arrive. Freeze the release only
# after runs drain, then use that same revision for checks and fast-forwarding.
# Comparing before the wait and pulling afterwards could skip required bot
# replays for changes that arrived in between.
as_app "cd $APP && git fetch -q origin main"
RELEASE_SHA=$(as_app "cd $APP && git rev-parse origin/main")
if [ -n "${EXPECTED_RELEASE_SHA:-}" ] && [ "$RELEASE_SHA" != "$EXPECTED_RELEASE_SHA" ]; then
  echo 'origin/main changed while this release was waiting; not deploying an unreviewed revision'
  exit 1
fi
# Back up the database after active runs finish and before changing the live
# checkout or applying additive schema upgrades. Existing retention handles it.
install -d -m 700 /var/backups/myasis
BACKUP=/var/backups/myasis/pre-release-$(date -u +%Y%m%dT%H%M%SZ)-${RELEASE_SHA:0:12}.dump
(umask 077; sudo -u postgres pg_dump -Fc --dbname=myasis > "$BACKUP.part")
pg_restore --list "$BACKUP.part" > /dev/null
mv "$BACKUP.part" "$BACKUP"
echo "Pre-release database backup verified: $(basename "$BACKUP")"
REPLAY_REQUIRED=0
CHECK_BASE_SHA=HEAD
if [ -n "${REPLAY_BASELINE_SHA:-}" ]; then
  [[ "$REPLAY_BASELINE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Replay baseline must be a full production revision' >&2; exit 1; }
  [ "$REPLAY_BASELINE_SHA" != "$RELEASE_SHA" ] || { echo 'Production baseline cannot be the candidate release' >&2; exit 1; }
  as_app "cd $APP && git merge-base --is-ancestor $REPLAY_BASELINE_SHA $RELEASE_SHA"
  CHECK_BASE_SHA=$REPLAY_BASELINE_SHA
fi
if ! as_app "cd $APP && git diff --quiet $CHECK_BASE_SHA $RELEASE_SHA -- seek-bot"; then
  REPLAY_REQUIRED=1
fi
as_app "cd $APP && git merge --ff-only $RELEASE_SHA && git log --oneline -1"
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
# Allow the additional production-baseline compilation on the 2-vCPU server.
# Reserve two seconds for forced termination within the configured bound.
# A failed or timed-out check stops the release; it never counts as a pass.
echo "Running limited deployment checks ($CHECK_TIMEOUT_SECONDS-second maximum)"
as_app "cd $APP && timeout --signal=TERM --kill-after=2s 60s bash deploy/check-application-service.sh"
FORCE_FLAG=0
if [ "${FORCE_DEPLOY:-}" = 1 ]; then FORCE_FLAG=1; fi
REPLAY_BASELINE_FLAG=""
if [ -n "${REPLAY_BASELINE_SHA:-}" ]; then
  [[ "$REPLAY_BASELINE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Replay baseline must be a full production revision' >&2; exit 1; }
  REPLAY_BASELINE_FLAG="REPLAY_BASELINE_SHA=$REPLAY_BASELINE_SHA "
fi
as_app "cd $APP && ${REPLAY_BASELINE_FLAG}FORCE_DEPLOY=$FORCE_FLAG timeout --signal=TERM --kill-after=2s ${CHECK_SOFT_TIMEOUT_SECONDS}s bash deploy/smoke-check.sh $REPLAY_REQUIRED"
# Apply idempotent schema upgrades before the new dashboard and its scheduler
# start querying new columns. A migration failure leaves the old process up.
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx scripts/migrate-db.mts"
if [ "$OPERATOR_HOLD_REQUIRED" = 1 ]; then
  # JSON data only, passed as one quoted argument to a fixed reviewed CLI.
  # Root can read a private root-owned plan without exposing it to the app user.
  (cd "$APP/dashboard" && ../seek-bot/node_modules/.bin/tsx scripts/apply-operator-holds.mts "$OPERATOR_HOLD_PLAN")
fi
if [ -f /etc/owtomate-repair-pilot.json ]; then bash "$APP/deploy/install-repair-pilot.sh" --refresh; fi
bash "$APP/deploy/install-job-index.sh"
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
# Refresh the independent application service only after the drain above.
# Routine dashboard restarts never restart this service or its browser children.
as_app "cd $APP && ${RUN_LIMIT}pm2 startOrReload ecosystem.config.cjs --only owtomate-applications --update-env > /dev/null"
as_app "cd $APP && ${RUN_LIMIT}PUBLIC_SITE_URL=http://127.0.0.1:5191 pm2 startOrReload ecosystem.config.cjs --only myasis-dashboard --update-env > /dev/null && pm2 save > /dev/null && echo restarted"
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
if [ "$OPERATOR_HOLD_REQUIRED" = 1 ]; then
  # Check the restarted dashboard middleware independently of the public bridge.
  for attempt in {1..30}; do
    if curl -fsS http://127.0.0.1:5180/api/auth/me | node -e 'let body="";process.stdin.on("data",x=>body+=x);process.stdin.on("end",()=>{try{const value=JSON.parse(body);if(!Object.hasOwn(value,"user"))process.exit(1)}catch{process.exit(1)}})'; then break; fi
    if [ "$attempt" = 30 ]; then echo 'dashboard API failed operator safety health check' >&2; exit 1; fi
    sleep 1
  done
  (cd "$APP/dashboard" && ../seek-bot/node_modules/.bin/tsx scripts/apply-operator-holds.mts --verify "$OPERATOR_HOLD_PLAN")
  # The EXIT trap may open the gate only after holds, the restarted guard and
  # both health checks have completed successfully.
  OPERATOR_HOLD_RELEASE_READY=1
fi
