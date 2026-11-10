#!/usr/bin/env bash
# Execute the fixed repair validation suite in a networkless temporary service.
# The caller must construct an immutable git snapshot with approved source edits;
# this script never accepts a command, repository path, user or mount from a model.
set -euo pipefail
if [ "$(id -u)" != 0 ]; then echo 'Run the isolated validator as root.' >&2; exit 1; fi
case_id=${1:-}
if [[ ! "$case_id" =~ ^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$ ]]; then
  echo 'Invalid repair case ID.' >&2; exit 1
fi
base=/var/lib/owtomate-repair/cases
input="$base/$case_id"
if [ "$(stat -c '%u:%a' /var/lib/owtomate-repair 2>/dev/null || true)" != '0:700' ] || [ "$(stat -c '%u:%a' "$base" 2>/dev/null || true)" != '0:700' ]; then
  echo 'Repair case directories must be private and root-owned.' >&2; exit 1
fi
if [ ! -d "$input" ] || [ "$(realpath "$input")" != "$input" ] || [ -L "$input" ]; then
  echo 'Repair snapshot is unavailable or is not a direct case directory.' >&2; exit 1
fi
# Source snapshots must be immutable while a test is running. The runner has
# no access to user profiles, production .env, browser sessions or networking.
if [ "$(stat -c '%u' "$input")" != 0 ] || [ "$(stat -c '%a' "$input")" != 755 ]; then
  echo 'Repair snapshot must be root-owned with mode 755.' >&2; exit 1
fi
app=/home/myasis/myasis
result="$base/$case_id.result"
if [ -e "$result" ]; then echo 'Repair result already exists.' >&2; exit 1; fi
mkdir -m 777 "$result"
systemd-run --wait --pipe --collect \
  --property=DynamicUser=yes --property=ProtectHome=yes --property=PrivateNetwork=yes \
  --property=ProtectSystem=strict --property=NoNewPrivileges=yes --property=PrivateDevices=yes \
  --property=ProtectKernelTunables=yes --property=ProtectControlGroups=yes --property=ProtectProc=invisible \
  --property=TemporaryFileSystem=/run:ro --property=InaccessiblePaths=-/var/lib \
  --property=MemoryMax=2G --property=TasksMax=256 --property=RuntimeMaxSec=240 --property=CPUQuota=100% \
  --property="BindReadOnlyPaths=$input:/run/repair-source" \
  --property="BindReadOnlyPaths=$app/seek-bot/node_modules:/run/repair-bot-modules" \
  --property="BindReadOnlyPaths=$app/dashboard/node_modules:/run/repair-dashboard-modules" \
  --property="BindPaths=$result:/run/repair-output" \
  /bin/bash -c '
    set -euo pipefail
    mkdir -p /tmp/repair-work
    export HOME=/tmp/repair-work
    cp -R /run/repair-source/. /tmp/repair-work/
    mkdir -p /tmp/repair-work/seek-bot/node_modules /tmp/repair-work/dashboard/node_modules
    cp -R /run/repair-bot-modules/. /tmp/repair-work/seek-bot/node_modules/
    cp -R /run/repair-dashboard-modules/. /tmp/repair-work/dashboard/node_modules/
    cd /tmp/repair-work/seek-bot
    export CHROME_PATH=/usr/bin/google-chrome-stable
    npm run build
    find dist -type f -print0 | sort -z | xargs -0 sha256sum > /tmp/compiled-before.sha256
    node --test dist/agent/agent-file-inventory.test.js dist/agent/application-readiness.test.js dist/agent/submission-control.test.js dist/agent/native-browser.test.js dist/agent/observe-frames.test.js
    node --test dist/agent/tool-input.test.js dist/agent/application-memory.test.js dist/agent/budget-workflows.test.js
    node dist/agent/question-evidence.test.js
    node --test dist/agent/live-repair.test.js
    node dist/agent/live-repair-browser.test.js
    node dist/agent/attention-feedback.test.js
    node dist/agent/halt-review.test.js
    sha256sum -c /tmp/compiled-before.sha256 >/dev/null
    test -z "$(find dist -type l -print -quit)"
    tar -cf /run/repair-output/dist.tar dist
  '
test -f "$result/dist.tar" && test ! -L "$result/dist.tar"
chown --no-dereference root:root "$result" "$result/dist.tar"
chmod 700 "$result"
chmod 600 "$result/dist.tar"
