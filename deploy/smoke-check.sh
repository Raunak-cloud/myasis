#!/usr/bin/env bash
# Small automatic checks. deploy.sh bounds this entire phase to 180 seconds.
# Comprehensive suites remain available through their manual commands.
set -euo pipefail
# Keep background groups in the timeout-managed process group.
set +m
APP=$(cd "$(dirname "$0")/.." && pwd)
cd "$APP"
for script in deploy/deploy.sh deploy/public-site.sh deploy/smoke-check.sh deploy/install-repair-pilot.sh deploy/repair-pilot-sandbox.sh; do bash -n "$script"; done
REPLAY_REQUIRED=${1:-0}

# Each group uses its own process state and fixture directories. Check every
# child exit status; launching a background job alone never establishes success.
check_dashboard() (
  trap - EXIT
  set -euo pipefail
cd "$APP/dashboard"
npm run test:statuses
node --test server/form-lab/engine.test.mjs
../seek-bot/node_modules/.bin/tsx server/form-lab-access.test.ts
../seek-bot/node_modules/.bin/tsx --test server/run-diagnostics.test.ts
../seek-bot/node_modules/.bin/tsx --test server/admin-run-costs.test.ts
../seek-bot/node_modules/.bin/tsx --test server/targeted-retry-*.test.ts
../seek-bot/node_modules/.bin/tsx --test server/repair-*.test.ts
../seek-bot/node_modules/.bin/tsx scripts/test-visitor-analytics.mts
../seek-bot/node_modules/.bin/tsx server/visits.test.ts
../seek-bot/node_modules/.bin/tsx server/visits-access.test.ts
../seek-bot/node_modules/.bin/tsx --test server/job-sources.test.ts
../seek-bot/node_modules/.bin/tsx --test server/application-model-policy.test.ts server/application-environment.test.ts server/application-agent-policy.test.ts server/operator-run-plan.test.ts
../seek-bot/node_modules/.bin/tsx --test server/security-retry.test.ts
../seek-bot/node_modules/.bin/tsx server/security-retry-db.test.ts
../seek-bot/node_modules/.bin/tsx --test server/gmail-api-reader.test.ts
../seek-bot/node_modules/.bin/tsx server/site-accounts.test.ts
../seek-bot/node_modules/.bin/tsx server/answers.test.ts
../seek-bot/node_modules/.bin/tsx server/attention-lifecycle.test.ts
../seek-bot/node_modules/.bin/tsx server/employer-account-attention.test.ts
../seek-bot/node_modules/.bin/tsx scripts/test-admin-user-preferences.mts
../seek-bot/node_modules/.bin/tsx server/application-review-holds.test.ts
../seek-bot/node_modules/.bin/tsx server/application-review-document-restore.test.ts
../seek-bot/node_modules/.bin/tsx server/application-review-answer-correction.test.ts

)

check_bot() (
  trap - EXIT
  set -euo pipefail
if [ "$REPLAY_REQUIRED" = 1 ]; then
  cd "$APP/seek-bot"
  node dist/company-match.test.js
  node --test dist/application-model.test.js dist/application-model-cache.test.js dist/agent/stage-model-routing.test.js
  node --test dist/answer-eligibility.test.js dist/agent/personal-declaration-policy.test.js dist/agent/provider-tool-schema.test.js dist/fit-provenance.test.js
  node --test dist/question-snapshot.test.js dist/question-patterns.test.js dist/answer-gate.test.js dist/agent/agent-only-evidence.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node --test dist/agent/question-robustness-browser.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/question-evidence.test.js
  node --test dist/agent/live-repair.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/live-repair-browser.test.js
  node --test dist/agent/investigation.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/investigation-browser.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/attention-feedback.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/halt-review.test.js
  node --test --test-name-pattern='admin repair|operator discovery' dist/review-budget.test.js
  node --test dist/discovery-seeds.test.js
  node --test dist/agent/attempt-diagnostics.test.js dist/browser-deadline.test.js dist/discovery-search.test.js dist/discovery-policy.test.js
  node --test dist/agent/generation-recovery.test.js dist/agent/celeris-queue.test.js dist/agent/openrouter.test.js dist/agent/tool-input.test.js dist/agent/agent-only-transcript.test.js dist/agent/application-policy.test.js dist/agent/application-readiness.test.js dist/agent/application-turn.test.js dist/agent/consultation.test.js dist/agent/recovery-checkpoint.test.js dist/agent/recovery-record.test.js dist/agent/progress-budget.test.js dist/agent/agent-file-inventory.test.js dist/verification-email-local.test.js dist/gmail-verification.test.js dist/gmail-read-cancellation.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node --test dist/agent/automatic-specialist.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/browser-command-contract.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/browser-snapshot-action.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/agent-document-provenance.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/agent-file-tools.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node --test dist/agent/approved-letter-browser.test.js dist/agent/observe-frames.test.js dist/agent/indeed-cover-letter.test.js dist/gmail-browser-readiness.test.js dist/agent/prepared-finalization-budget.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/gmail-spam-browser.test.js
  node dist/site-credentials.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node --test dist/agent/authentication-state.test.js dist/agent/authentication-contract.test.js dist/site-auth.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node dist/agent/employer-account-first.test.js
  CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} node --test dist/agent/budget-workflows.test.js
  node dist/fit-assessment.test.js
  node dist/fit-intent-provenance.test.js
  shopt -s nullglob
  CORPORA=("$APP"/seek-bot/data/users/*/form-corpus)
  if [ ${#CORPORA[@]} -gt 0 ]; then
    scratch=$(mktemp -d "$APP/output/deploy-smoke.XXXXXX")
    trap 'rm -rf "$scratch"' EXIT
    release=$(git rev-parse HEAD)
    node "$APP/deploy/replay-sample.mjs" "$scratch/corpus" 10 "$release" "${CORPORA[@]}"
    if ! CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable} CELERIS_API_KEY=replay-only node dist/form-replay.js "$scratch/corpus"; then
      if [ "${FORCE_DEPLOY:-}" != 1 ]; then exit 1; fi
      echo 'Continuing past reviewed replay findings (FORCE_DEPLOY=1)'
    fi
  fi
fi
)

CHECK_LOG_DIR=$(mktemp -d "$APP/output/deploy-checks.XXXXXX")
cleanup_check_logs() {
  local check_status=$?
  if [ "$check_status" = 0 ]; then rm -rf "$CHECK_LOG_DIR";
  else printf 'Check logs retained at %s\n' "$CHECK_LOG_DIR" >&2; fi
  return "$check_status"
}
trap cleanup_check_logs EXIT
# A signal can interrupt wait with $? still zero; preserve failure for cleanup.
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
check_dashboard > "$CHECK_LOG_DIR/dashboard.log" 2>&1 &
dashboard_pid=$!
check_bot > "$CHECK_LOG_DIR/bot.log" 2>&1 &
bot_pid=$!
checks_failed=0
if wait "$dashboard_pid"; then echo 'Dashboard checks passed'; else checks_failed=1; echo 'Dashboard checks failed' >&2; fi
cat "$CHECK_LOG_DIR/dashboard.log"
if wait "$bot_pid"; then echo 'Bot checks passed'; else checks_failed=1; echo 'Bot checks failed' >&2; fi
cat "$CHECK_LOG_DIR/bot.log"
[ "$checks_failed" = 0 ] || exit 1

echo 'Limited deployment checks passed'
