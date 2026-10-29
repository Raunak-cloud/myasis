#!/usr/bin/env bash
# Small automatic checks. deploy.sh bounds this entire phase to 60 seconds.
# Comprehensive suites remain available through their manual commands.
set -euo pipefail
APP=$(cd "$(dirname "$0")/.." && pwd)
cd "$APP"
for script in deploy/deploy.sh deploy/public-site.sh deploy/smoke-check.sh; do bash -n "$script"; done
cd "$APP/dashboard"
npm run test:statuses

if [ "${1:-0}" = 1 ]; then
  cd "$APP/seek-bot"
  node --test dist/agent/application-policy.test.js dist/agent/application-readiness.test.js dist/agent/recovery-checkpoint.test.js dist/agent/progress-budget.test.js
  node dist/fit-assessment.test.js
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
echo 'Limited deployment checks passed'
