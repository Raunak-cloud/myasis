#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../dashboard"
../seek-bot/node_modules/.bin/tsx scripts/test-hr-outreach.mts
