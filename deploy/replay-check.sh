#!/usr/bin/env bash
# Replays every recorded employer form page against the code about to be
# deployed, before the live tree is touched. Run by deploy.sh; usable alone:
#   bash /home/myasis/myasis/deploy/replay-check.sh
#
# The new commit is built in its own worktree, so the replay never disturbs a
# run in progress or the code it is using. A regression (a field no longer
# found, a real label lost, a security check or a cover-letter place read
# differently) fails the check; deploy.sh then stops unless FORCE_DEPLOY=1.
set -euo pipefail
APP=/home/myasis/myasis
TREE=/tmp/owtomate-replay-$$
as_app() { sudo -u myasis -H bash -lc "$1"; }

cleanup() { as_app "cd $APP && git worktree remove --force $TREE 2>/dev/null || rm -rf $TREE; git worktree prune" || true; }
trap cleanup EXIT

as_app "cd $APP && git fetch -q origin main && git worktree add -q --detach $TREE origin/main"
as_app "set -o pipefail; cd $TREE/seek-bot && PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund 2>&1 | tail -1"
as_app "set -o pipefail; cd $TREE/seek-bot && npm run build 2>&1 | tail -1"

shopt -s nullglob
CORPORA=("$APP"/seek-bot/data/users/*/form-corpus)
if [ ${#CORPORA[@]} -eq 0 ]; then
  echo "replay: no recorded form pages yet"
  exit 0
fi
as_app "cd $TREE/seek-bot && CHROME_PATH=\${CHROME_PATH:-/usr/bin/google-chrome-stable} CELERIS_API_KEY=replay-only node dist/form-replay.js ${CORPORA[*]}"
