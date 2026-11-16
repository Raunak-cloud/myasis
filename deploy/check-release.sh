#!/usr/bin/env bash
# deploy.sh bounds this whole group, including the HR regression checks.
set -euo pipefail
cd "$(dirname "$0")/.."
timeout --signal=TERM --kill-after=2s 60s bash deploy/check-application-service.sh
timeout --signal=TERM --kill-after=2s 180s bash deploy/check-hr-outreach.sh
bash deploy/smoke-check.sh "${1:-0}"
