#!/usr/bin/env bash
# Root-owned maintenance code; fortnightly idle checks, no customer browser restarts.
set -euo pipefail
APP=${1:-/home/myasis/myasis}
APP=$(realpath "$APP")
test "$(id -u)" = 0
test -f "$APP/deploy/chrome-update.py"
test -f "$APP/deploy/chrome-session-smoke.mjs"
install -d -m 755 /usr/local/lib/owtomate
install -m 644 "$APP/deploy/chrome-update.py" /usr/local/lib/owtomate/chrome-update.py
# Unit configuration accepts only a simple absolute application path.
[[ "$APP" =~ ^/[a-zA-Z0-9_/-]+$ ]]
cat > /etc/systemd/system/owtomate-chrome-update.service <<EOF
[Unit]
Description=Update Owtomate Chrome while browsers are idle
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/lib/owtomate/chrome-update.py --app $APP
UMask=0077
TimeoutStartSec=20min
KillMode=control-group
Nice=10
EOF
cat > /etc/systemd/system/owtomate-chrome-update.timer <<'EOF'
[Unit]
Description=Check fortnightly for safe Owtomate Chrome updates

[Timer]
OnActiveSec=14d
OnUnitActiveSec=14d
RandomizedDelaySec=5min
Unit=owtomate-chrome-update.service

[Install]
WantedBy=timers.target
EOF
systemd-analyze verify /etc/systemd/system/owtomate-chrome-update.service /etc/systemd/system/owtomate-chrome-update.timer
systemctl daemon-reload
systemctl enable --now owtomate-chrome-update.timer
echo 'Automatic Chrome updates enabled. Active browsers are left running.'
