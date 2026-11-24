#!/usr/bin/env bash
# deploy.sh bounds this whole group, including the HR regression checks.
set -euo pipefail
cd "$(dirname "$0")/.."
# Narrow releases use checks specific to the changed feature, with a 60-second
# test budget. Unknown or mixed releases keep all checks.
if [[ "${2:-}" =~ ^[a-f0-9]{40}$ ]] && [[ "${3:-}" =~ ^[a-f0-9]{40}$ ]] && [ "$(git rev-parse HEAD)" = "$3" ]; then
  feed_handoff_only=1
  feed_policy_changed=0
  while IFS= read -r path; do
    case "$path" in
      seek-bot/src/retired-job-sources.ts) feed_policy_changed=1 ;;
      dashboard/server/entitlements.ts|dashboard/server/retired-job-sources.test.ts|seek-bot/src/agent/retired-feed-handoff.test.ts) ;;
      seek-bot/src/application-skip-memory.ts|seek-bot/src/application-skip-memory.test.ts|deploy/check-release.sh) ;;
      *) feed_handoff_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$feed_handoff_only" = 1 ] && [ "$feed_policy_changed" = 1 ] && [ -z "${REPLAY_BASELINE_SHA:-}" ]; then
    timeout --signal=TERM --kill-after=2s 58s bash -e -c '
      export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
      (cd dashboard && ../seek-bot/node_modules/.bin/tsx --test server/retired-job-sources.test.ts) & dashboard_tests=$!
      cd seek-bot
      node --test dist/agent/retired-feed-handoff.test.js dist/application-skip-memory.test.js dist/external-navigation.test.js
      wait "$dashboard_tests"
      if [ "$1" = 1 ]; then
        shopt -s nullglob
        corpora=(data/users/*/form-corpus)
        if [ "${#corpora[@]}" -gt 0 ]; then
          scratch=$(mktemp -d ../output/deploy-handoff.XXXXXX)
          trap '\''rm -rf "$scratch"'\'' EXIT
          node ../deploy/replay-sample.mjs "$scratch/corpus" 10 "$2" "${corpora[@]}"
          CELERIS_API_KEY=replay-only node dist/form-replay.js "$scratch/corpus"
        fi
      fi
    ' bash "${1:-0}" "$3"
    echo 'Targeted employer handoff and discovery checks passed (60-second maximum)'
    exit 0
  fi
  hr_research_only=1
  hr_research_changed=0
  while IFS= read -r path; do
    case "$path" in
      dashboard/server/hr-outreach/research.ts) hr_research_changed=1 ;;
      dashboard/server/hr-outreach/discovery.ts|dashboard/server/hr-outreach/research.test.ts|dashboard/server/hr-outreach/README.md|deploy/check-release.sh) ;;
      *) hr_research_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$hr_research_only" = 1 ] && [ "$hr_research_changed" = 1 ]; then
    (
      cd dashboard
      timeout --signal=TERM --kill-after=2s 58s ../seek-bot/node_modules/.bin/tsx --test \
        server/hr-outreach/research.test.ts server/hr-outreach/discovery.test.ts server/hr-outreach/worker.test.ts
    )
    echo 'Targeted hiring-email research checks passed (60-second maximum)'
    exit 0
  fi
  paid_plans_only=1
  paid_plans_changed=0
  while IFS= read -r path; do
    case "$path" in
      dashboard/src/pricing.ts) paid_plans_changed=1 ;;
      dashboard/server/billing-checkouts.ts|dashboard/server/billing-fulfillment.ts|dashboard/server/billing-policy.ts|dashboard/server/billing-unlimited.test.ts|dashboard/server/billing-upgrades.test.ts|dashboard/server/application-credits.ts|dashboard/server/db/schema.sql) ;;
      dashboard/server/entitlements.ts|dashboard/server/start-run.ts|dashboard/server/runner.ts|dashboard/server/employer-site-access.ts|dashboard/server/operator-run-plan.ts|dashboard/server/application-environment.test.ts|dashboard/server/free-preparation.ts|dashboard/server/application-reviews.ts|dashboard/server/free-preparation.test.ts) ;;
      dashboard/server/signin.ts|dashboard/server/setup.ts|dashboard/server/job-sources.ts|dashboard/server/today.ts|dashboard/server/run-policy.test.ts|dashboard/server/targeted-retry-start.test.ts|dashboard/server/employer-applications.test.ts|dashboard/server/employer-site-access.test.ts|dashboard/server/free-trial.test.ts|dashboard/server/simulate.ts) ;;
      dashboard/src/billing-offers.ts|dashboard/src/components/Landing.tsx|dashboard/src/components/PricingPanel.tsx|dashboard/src/components/PricingPanel.css|dashboard/src/components/PricingSources.tsx|dashboard/scripts/test-pricing-upgrades-ui.mts) ;;
      dashboard/src/App.tsx|dashboard/src/boards.ts|dashboard/vite.config.ts|dashboard/index.html|dashboard/terms.html|dashboard/README.md|dashboard/src/components/JobBoardsDialog.tsx|dashboard/src/components/RunPanel.tsx|dashboard/src/components/SetupPanel.tsx|dashboard/src/components/SeekSignIn.tsx|dashboard/scripts/test-jora-beta-ui.mts) ;;
      seek-bot/src/guest-applications.ts|seek-bot/src/guest-preparation.ts|seek-bot/src/prepare-job.ts|seek-bot/src/browser.ts|seek-bot/src/main.ts|seek-bot/src/config.ts|seek-bot/src/application-workers.ts|seek-bot/src/application-workers.test.ts|seek-bot/src/guest-applications.test.ts|seek-bot/src/guest-preparation.test.ts|seek-bot/src/prepare-job.test.ts) ;;
      seek-bot/src/agent/agent-only.ts|seek-bot/src/agent/application-policy.ts|seek-bot/src/agent/authentication.ts|seek-bot/src/agent/authentication-contract.test.ts|deploy/check-release.sh) ;;
      *) paid_plans_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$paid_plans_only" = 1 ] && [ "$paid_plans_changed" = 1 ]; then
    timeout --signal=TERM --kill-after=2s 58s bash -e -c '
      export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
      node --test seek-bot/dist/agent/authentication-contract.test.js seek-bot/dist/application-workers.test.js seek-bot/dist/guest-applications.test.js seek-bot/dist/prepare-job.test.js seek-bot/dist/guest-preparation.test.js & agent_tests=$!
      cd dashboard
      ../seek-bot/node_modules/.bin/tsx --test server/application-environment.test.ts server/billing-upgrades.test.ts server/billing-unlimited.test.ts server/free-preparation.test.ts server/free-trial.test.ts server/employer-applications.test.ts server/run-policy.test.ts server/targeted-retry-start.test.ts & policy_tests=$!
      wait "$agent_tests"
      ../seek-bot/node_modules/.bin/tsx scripts/test-pricing-upgrades-ui.mts
      wait "$policy_tests"
    '
    echo 'Targeted paid-plan checkout, access and preparation checks passed (60-second maximum)'
    exit 0
  fi
  board_brand_only=1
  board_brand_changed=0
  while IFS= read -r path; do
    case "$path" in
      dashboard/src/components/BoardBrand.tsx) board_brand_changed=1 ;;
      dashboard/src/App.tsx|dashboard/src/components/PricingSources.tsx|dashboard/src/index.css|dashboard/scripts/test-jora-beta-ui.mts|deploy/check-release.sh) ;;
      *) board_brand_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$board_brand_only" = 1 ] && [ "$board_brand_changed" = 1 ]; then
    timeout --signal=TERM --kill-after=2s 58s bash -e -c '
      export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
      bash -n deploy/check-release.sh
      cd dashboard
      ../seek-bot/node_modules/.bin/tsx scripts/test-jora-beta-ui.mts
      ../seek-bot/node_modules/.bin/tsx scripts/test-pricing-upgrades-ui.mts
    '
    echo 'Targeted job-board branding UI checks passed (60-second maximum)'
    exit 0
  fi
  topup_removal_only=1
  topup_policy_changed=0
  while IFS= read -r path; do
    case "$path" in
      dashboard/server/billing-policy.ts) topup_policy_changed=1 ;;
      dashboard/server/alerts.ts|dashboard/server/billing-upgrades.test.ts|dashboard/server/billing-unlimited.test.ts|dashboard/src/billing.ts|dashboard/src/components/Landing.tsx|dashboard/src/components/Landing.css|dashboard/src/components/PricingPanel.tsx|dashboard/src/components/SupportPanel.tsx|dashboard/src/index.css|dashboard/scripts/test-pricing-upgrades-ui.mts|deploy/check-release.sh) ;;
      *) topup_removal_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$topup_removal_only" = 1 ] && [ "$topup_policy_changed" = 1 ]; then
    timeout --signal=TERM --kill-after=2s 58s bash -e -c '
      export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
      bash -n deploy/check-release.sh
      cd dashboard
      ../seek-bot/node_modules/.bin/tsx --test server/billing-upgrades.test.ts server/billing-unlimited.test.ts
      ../seek-bot/node_modules/.bin/tsx scripts/test-pricing-upgrades-ui.mts
    '
    echo 'Targeted top-up retirement checks passed (60-second maximum)'
    exit 0
  fi
  free_offer_only=1
  free_offer_changed=0
  while IFS= read -r path; do
    case "$path" in
      dashboard/src/components/FreeTrialOffer.tsx|dashboard/src/components/PricingSources.tsx|dashboard/src/components/PricingPanel.tsx|dashboard/src/components/PricingPanel.css) free_offer_changed=1 ;;
      dashboard/src/index.css|dashboard/scripts/test-free-trial-ui.mts|deploy/check-release.sh) ;;
      dashboard/src/components/Landing.tsx|dashboard/src/pricing.ts|dashboard/scripts/test-pricing-upgrades-ui.mts) ;;
      *) free_offer_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$free_offer_only" = 1 ] && [ "$free_offer_changed" = 1 ]; then
    timeout --signal=TERM --kill-after=2s 58s bash -e -c '
      export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
      bash -n deploy/check-release.sh
      cd dashboard
      ../seek-bot/node_modules/.bin/tsx scripts/test-free-trial-ui.mts
      ../seek-bot/node_modules/.bin/tsx scripts/test-pricing-upgrades-ui.mts
    '
    echo 'Targeted free offer UI checks passed (60-second maximum)'
    exit 0
  fi
  email_preference_only=1
  email_preference_changed=0
  while IFS= read -r path; do
    case "$path" in
      dashboard/src/components/ApplicationsPanel.tsx|dashboard/src/components/RunPanel.tsx|dashboard/src/components/HrOutreachPanel.tsx|dashboard/src/components/HrOutreachActivity.tsx|dashboard/src/components/ApplicationOverview.tsx|dashboard/src/components/BoardBrand.tsx|dashboard/src/App.tsx|dashboard/src/index.css) email_preference_changed=1 ;;
      dashboard/vite.config.ts|dashboard/server/hr-outreach/store.ts|dashboard/server/hr-outreach/store.test.ts) ;;
      dashboard/src/format.ts|dashboard/scripts/test-hr-outreach-ui.mts|dashboard/scripts/test-hr-outreach-access.mts|dashboard/scripts/test-jora-beta-ui.mts|deploy/check-release.sh) ;;
      dashboard/public/platforms/pageup.svg|dashboard/public/platforms/workday.svg|dashboard/public/platforms/greenhouse.svg|dashboard/public/platforms/smartrecruiters.svg|dashboard/public/platforms/README.md) ;;
      *) email_preference_only=0 ;;
    esac
  done < <(git diff --name-only "$2" "$3")
  if [ "$email_preference_only" = 1 ] && [ "$email_preference_changed" = 1 ]; then
    timeout --signal=TERM --kill-after=2s 58s bash -e -c '
      export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
      bash -n deploy/check-release.sh
      cd dashboard
      ../seek-bot/node_modules/.bin/tsx scripts/test-hr-outreach-ui.mts & hr_pid=$!
      ../seek-bot/node_modules/.bin/tsx scripts/test-jora-beta-ui.mts & jora_pid=$!
      ../seek-bot/node_modules/.bin/tsx --test server/hr-outreach/store.test.ts & store_pid=$!
      wait "$hr_pid"
      wait "$jora_pid"
      wait "$store_pid"
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
      node dist/agent/dropdown-agent-browser.test.js
      node dist/agent/agent-batch-browser.test.js
    '
    echo 'Targeted dropdown recovery release checks passed (60-second maximum)'
    exit 0
  fi
fi
timeout --signal=TERM --kill-after=2s 60s bash deploy/check-application-service.sh
timeout --signal=TERM --kill-after=2s 180s bash deploy/check-hr-outreach.sh
timeout --signal=TERM --kill-after=2s 60s bash -e -c '
  export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
  cd seek-bot
  node --test dist/agent/recovery-rollback-browser.test.js dist/agent/browser-tools.test.js dist/agent/browser-tools-browser.test.js dist/agent/browser-snapshot-action.test.js dist/agent/simple-browser-tools.test.js dist/agent/tool-guidance-examples.test.js dist/agent/application-memory.test.js dist/agent/interaction-memory.test.js
'
bash deploy/smoke-check.sh "${1:-0}"
