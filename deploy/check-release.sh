#!/usr/bin/env bash
# deploy.sh bounds this whole group, including the HR regression checks.
set -euo pipefail
cd "$(dirname "$0")/.."
# A narrowly scoped dropdown release uses real-browser recovery checks, bounded
# to the documented 60-second test budget. Unknown/mixed changes keep all checks.
if [[ "${2:-}" =~ ^[a-f0-9]{40}$ ]] && [[ "${3:-}" =~ ^[a-f0-9]{40}$ ]] && [ "$(git rev-parse HEAD)" = "$3" ]; then
  email_preference_only=1
  email_preference_changed=0
  while IFS= read -r path; do
    case "$path" in
      dashboard/src/components/ApplicationsPanel.tsx|dashboard/src/components/RunPanel.tsx|dashboard/src/components/HrOutreachPanel.tsx) email_preference_changed=1 ;;
      dashboard/src/index.css|dashboard/scripts/test-hr-outreach-ui.mts|deploy/check-release.sh) ;;
      *) email_preference_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$email_preference_only" = 1 ] && [ "$email_preference_changed" = 1 ]; then
    timeout --signal=TERM --kill-after=2s 58s bash -e -c '
      export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
      bash -n deploy/check-release.sh
      cd dashboard
      ../seek-bot/node_modules/.bin/tsx scripts/test-hr-outreach-ui.mts
    '
    echo 'Targeted email preference UI checks passed (60-second maximum)'
    exit 0
  fi
  direct_retry_only=1
  direct_retry_changed=0
  while IFS= read -r path; do
    case "$path" in
      seek-bot/src/direct-retry-approval.ts|seek-bot/src/direct-retry-approval.test.ts|seek-bot/src/direct-external.ts|seek-bot/src/direct-external.test.ts) direct_retry_changed=1 ;;
      deploy/check-release.sh) ;;
      *) direct_retry_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$direct_retry_only" = 1 ] && [ "$direct_retry_changed" = 1 ]; then
    timeout --signal=TERM --kill-after=2s 58s bash -e -c '
      export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
      bash -n deploy/check-release.sh
      cd seek-bot
      node --test dist/direct-retry-approval.test.js dist/direct-external.test.js dist/matched-application.test.js dist/duplicate-review.test.js
    '
    echo 'Targeted direct-retry approval checks passed (60-second maximum)'
    exit 0
  fi
  dropdown_only=1
  dropdown_changed=0
  while IFS= read -r path; do
    case "$path" in
      seek-bot/src/agent/dropdown-feedback.ts) dropdown_changed=1 ;;
      seek-bot/src/agent/visual-recovery.ts|seek-bot/src/agent/visual-recovery.test.ts|seek-bot/src/agent/visual-recovery-browser.test.ts) dropdown_changed=1 ;;
      seek-bot/src/agent/dropdown-feedback.test.ts|seek-bot/src/agent/dropdown-agent-browser.test.ts|seek-bot/src/agent/agent-only.ts|seek-bot/src/agent/native-browser.ts|seek-bot/src/agent/application-policy.ts|seek-bot/src/agent/ordinary-field-guidance.ts|recoveryskills.md|deploy/check-release.sh|deploy/deploy.sh) ;;
      *) dropdown_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$dropdown_only" = 1 ] && [ "$dropdown_changed" = 1 ]; then
    timeout --signal=TERM --kill-after=2s 58s bash -e -c '
      export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
      bash -n deploy/deploy.sh
      bash -n deploy/check-release.sh
      cd seek-bot
      node --test dist/agent/dropdown-feedback.test.js dist/agent/native-browser.test.js dist/agent/application-policy.test.js
      node --test dist/agent/visual-recovery.test.js
      node dist/agent/visual-recovery-browser.test.js
      node dist/agent/dropdown-agent-browser.test.js
      node dist/agent/agent-batch-browser.test.js
    '
    echo 'Targeted dropdown recovery release checks passed (60-second maximum)'
    exit 0
  fi
fi
timeout --signal=TERM --kill-after=2s 60s bash deploy/check-application-service.sh
timeout --signal=TERM --kill-after=2s 180s bash deploy/check-hr-outreach.sh
bash deploy/smoke-check.sh "${1:-0}"
