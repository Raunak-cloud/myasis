#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node seek-bot/node_modules/tsx/dist/cli.mjs --test \
  dashboard/server/run-memory.test.ts dashboard/server/application-worker-capacity.test.ts \
  dashboard/server/account-lifecycle.test.ts dashboard/server/admin-run-costs.test.ts
node --import ./seek-bot/node_modules/tsx/dist/loader.mjs dashboard/scripts/test-run-service.mts
node --import ./seek-bot/node_modules/tsx/dist/loader.mjs dashboard/scripts/test-run-service-pm2.mts
node --import ./seek-bot/node_modules/tsx/dist/loader.mjs dashboard/scripts/test-run-cost-totals.mts
