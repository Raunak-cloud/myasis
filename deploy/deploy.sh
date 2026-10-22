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

# Real employer form pages, replayed against the new code before anything live
# changes (deploy/replay-check.sh). A regression stops the deploy here, while
# the running code is untouched; FORCE_DEPLOY=1 overrides after a person has
# judged the difference (and accepted it with form-replay.js --accept).
as_app "cd $APP && git fetch -q origin main"
if as_app "cd $APP && git diff --quiet HEAD origin/main -- seek-bot deploy/replay-check.sh"; then
  echo 'replay: job-agent code unchanged; no form replay needed for this release'
elif ! bash "$APP/deploy/replay-check.sh"; then
  if [ "${FORCE_DEPLOY:-}" = 1 ]; then
    echo "replay found regressions; deploying anyway (FORCE_DEPLOY=1)"
  else
    echo "replay found regressions; not deploying (FORCE_DEPLOY=1 to override)"
    exit 1
  fi
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
as_app "cd $APP && node --test shared/celeris-queue.test.mjs"
as_app "cd $APP/seek-bot && node --test dist/agent/celeris-queue.test.js"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/celeris-queue.test.ts"
as_app "cd $APP/seek-bot && node dist/cost-ledger.test.js"
as_app "cd $APP/seek-bot && node --test dist/application-allowance.test.js dist/agent/agent-only-evidence.test.js dist/agent/agent-only-transcript.test.js dist/agent/agent-activity.test.js dist/agent/consultation.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node dist/agent/agent-only.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node dist/agent/field-batch.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node dist/agent/employer-routing.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node dist/gmail-mcp.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node --test dist/gmail-browser.test.js dist/verification-email-local.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node dist/agent/email-application.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node --test dist/agent-only-routing.test.js dist/application-worker-page.test.js"
as_app "cd $APP/seek-bot && node --test dist/application-model.test.js dist/agent/application-model-routing.test.js dist/agent/tool-input.test.js dist/agent/guards-budget.test.js dist/store-scope.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node --test dist/direct-external.test.js"
as_app "cd $APP/seek-bot && node dist/fit-contract.test.js && node dist/application-evidence.test.js && node dist/application-model-cache.test.js"
as_app "cd $APP/seek-bot && node dist/assessment-reuse.test.js"
as_app "cd $APP/seek-bot && node --test dist/parallel-ranking.test.js"
as_app "cd $APP/seek-bot && node scripts/test-ranking.mjs"
as_app "cd $APP/seek-bot && node --test dist/profile-salary.test.js dist/search-limits.test.js"
as_app "cd $APP/seek-bot && node --test dist/application-identity.test.js"
as_app "cd $APP/seek-bot && node --test dist/instruction-policy.test.js dist/job-evaluation-trust.test.js"
as_app "cd $APP/seek-bot && node dist/instruction-gate.test.js"
as_app "cd $APP/seek-bot && node --test dist/review-budget.test.js"
as_app "cd $APP/seek-bot && node --test dist/cover-letter-policy.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node dist/application-review.test.js"
as_app "cd $APP/seek-bot && node --test dist/application-workers.test.js dist/application-reservations.test.js dist/job-board-url.test.js dist/review-verdicts.test.js dist/external-url.test.js dist/live-workers.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node --test dist/application-worker-browser.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable FORM_SPEED_PILOT=true node dist/form-speed.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node dist/agent/committed-answers.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node dist/agent/saved-form.test.js"
as_app "cd $APP/seek-bot && node --test dist/form-replay-compare.test.js"
as_app "cd $APP/seek-bot && CHROME_PATH=/usr/bin/google-chrome-stable node dist/form-replay.test.js"
as_app "cd $APP/seek-bot && node --test dist/employer-browser-config.test.js dist/employer-browser-router.test.js dist/remote-browser-preview.test.js"
as_app "cd $APP/seek-bot && node --test dist/captcha/retry.test.js dist/captcha/diagnostics.test.js"
as_app "cd $APP/seek-bot && node dist/employer-browser.test.js"
as_app "cd $APP/seek-bot && node --test dist/smartrecruiters.test.js dist/employer-feeds.test.js dist/agent/apply-employer-job.test.js dist/agent/choose-option.test.js"
as_app "set -o pipefail; cd $APP/dashboard && npm run build 2>&1 | tail -1"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/public-website-proxy.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx server/search-terms.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx server/run-accounting.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx server/run-policy.test.ts"
as_app "cd $APP/dashboard && SEMI_AUTO_E2E_REPORT=$APP/output/semi-auto-e2e.json ../seek-bot/node_modules/.bin/tsx scripts/test-application-reviews.mts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/external-job-url.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/application-worker-policy.test.ts server/application-worker-capacity.test.ts server/application-platform-scope.test.ts server/skipped-retention.test.ts test/activity.test.mjs"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx server/application-costs.test.ts && ../seek-bot/node_modules/.bin/tsx scripts/test-application-costs-api.mts"
as_app "cd $APP/dashboard && SEMI_AUTO_E2E_REPORT=$APP/output/semi-auto-e2e.json ../seek-bot/node_modules/.bin/tsx scripts/test-smartrecruiters-ui.mts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx server/visits.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx server/visits-access.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx scripts/test-visitor-analytics.mts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx scripts/test-visitors-ui.mts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test test/live-action.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx scripts/test-live-workers-ui.mts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx scripts/test-application-costs-ui.mts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test test/activity.test.mjs"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/job-sources.test.ts server/application-model-policy.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/application-agent-policy.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/browser-run-policy.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/signin-input.test.ts server/signin-sessions.test.ts"
as_app "cd $APP/dashboard && CHROME_PATH=/usr/bin/google-chrome-stable ../seek-bot/node_modules/.bin/tsx scripts/test-signin-browser.mts"
as_app "cd $APP/dashboard && CHROME_PATH=/usr/bin/google-chrome-stable SIGNIN_RECOVERY_ROUNDS=1 ../seek-bot/node_modules/.bin/tsx scripts/test-signin-recovery.mts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx server/answers.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/gmail-connection.test.ts server/application-email.test.ts server/gmail-access.test.ts"
as_app "cd $APP/dashboard && CHROME_PATH=/usr/bin/google-chrome-stable ../seek-bot/node_modules/.bin/tsx scripts/test-gmail-ui.mts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx server/digest.test.ts && ../seek-bot/node_modules/.bin/tsx server/digest-preferences.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/account-lifecycle.test.ts && ../seek-bot/node_modules/.bin/tsx server/account-deletion.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx scripts/test-account-settings-api.mts"
as_app "cd $APP/dashboard && CHROME_PATH=/usr/bin/google-chrome-stable ../seek-bot/node_modules/.bin/tsx scripts/test-account-settings-ui.mts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/application-environment.test.ts server/assist.test.ts server/skipped.test.ts server/run-watchdog.test.ts server/chrome-profile.test.ts server/run-completion.test.ts server/salary.test.ts server/run-device.test.ts server/market-scout.test.ts server/blog/*.test.ts server/marketing/*.test.ts"
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx --test server/profile-export.test.ts"
as_app "cd $APP/market-scout && npm exec tsc -- -p . && npm test"
# Apply idempotent schema upgrades before the new dashboard and its scheduler
# start querying new columns. A migration failure leaves the old process up.
as_app "cd $APP/dashboard && ../seek-bot/node_modules/.bin/tsx scripts/migrate-db.mts"
# Cron invokes Bash explicitly, so a Git checkout cannot disable backups by
# resetting maintenance.sh's execute bit. Keep installed scheduling in sync.
bash "$APP/deploy/maintenance.test.sh"
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
