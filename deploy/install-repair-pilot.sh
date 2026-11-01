#!/usr/bin/env bash
# Install only trusted broker code; generated patches never enter this directory.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Root is required.' >&2; exit 1; }
app=/home/myasis/myasis
install=/opt/owtomate-repair-pilot
mkdir -p "$install/dashboard/server" "$install/dashboard/scripts" "$install/deploy" /opt/owtomate-repair-releases
mkdir -p "$install/seek-bot/src" /opt/owtomate-repair-releases/tickets
for name in repair-pilot repair-release repair-safety; do
  install -o root -g root -m 644 "$app/seek-bot/src/$name.ts" "$install/seek-bot/src/$name.ts"
done
mkdir -p /var/lib/owtomate-repair/cases
chmod 700 /var/lib/owtomate-repair /var/lib/owtomate-repair/cases
for name in repair-pilot repair-coder repair-model repair-validation repair-release; do
  install -o root -g root -m 644 "$app/dashboard/server/$name.ts" "$install/dashboard/server/$name.ts"
done
install -o root -g root -m 644 "$app/dashboard/scripts/repair-pilot-service.mts" "$install/dashboard/scripts/repair-pilot-service.mts"
install -o root -g root -m 644 "$app/deploy/repair-pilot-sandbox.sh" "$install/deploy/repair-pilot-sandbox.sh"
install -o root -g root -m 644 "$app/deploy/repair-unpack.py" "$install/deploy/repair-unpack.py"
echo '{"type":"module"}' > "$install/package.json"
chmod 644 "$install/package.json"
if [ "${1:-}" = --enable ]; then
  python3 - <<'PY'
import datetime,json,os
p='/etc/owtomate-repair-pilot.json'
v={'enabled':True,'ownerId':'1','ownerEmail':'raunak.vision@gmail.com','activatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'maxCasesPerDay':2}
with open(p+'.tmp','w') as f: json.dump(v,f)
os.chmod(p+'.tmp',0o644)
os.replace(p+'.tmp',p)
PY
fi
test -f /etc/owtomate-repair-pilot.json
python3 - <<'PY'
import json,os
p='/etc/owtomate-repair-pilot.json'
with open(p) as f: v=json.load(f)
v['recoveryMode']='in-run'
with open(p+'.tmp','w') as f: json.dump(v,f)
os.chmod(p+'.tmp',0o644)
os.replace(p+'.tmp',p)
PY
cat > /etc/systemd/system/owtomate-repair-pilot.service <<'UNIT'
[Unit]
Description=Owtomate single-admin MiniMax repair pilot
After=network-online.target postgresql.service
Wants=network-online.target
[Service]
Type=simple
User=root
WorkingDirectory=/opt/owtomate-repair-pilot
ExecStart=/usr/bin/node /home/myasis/myasis/seek-bot/node_modules/tsx/dist/cli.mjs /opt/owtomate-repair-pilot/dashboard/scripts/repair-pilot-service.mts
Restart=on-failure
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
ReadWritePaths=/var/lib/owtomate-repair /opt/owtomate-repair-releases
MemoryMax=800M
TasksMax=64
UMask=0077
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable owtomate-repair-pilot.service >/dev/null
systemctl restart owtomate-repair-pilot.service
systemctl is-active --quiet owtomate-repair-pilot.service
echo 'Repair pilot broker installed for account 1.'
