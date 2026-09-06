#!/usr/bin/env bash
#
# Myasis — VPS setup (Ubuntu/Debian: Hetzner, DigitalOcean, etc.)
#
#   scp setup-vps.sh user@your-vps:~/
#   ssh user@your-vps 'bash ~/setup-vps.sh'
#
# Installs Node, Chrome and a virtual display, then runs Chrome as a service
# with the DevTools port bound to loopback only.
#
# It deliberately does NOT open any port to the internet. Reach the dashboard
# through an SSH tunnel (printed at the end).

set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/myasis}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/chrome-profile}"
CDP_PORT="${CDP_PORT:-9333}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$1"; }

[[ $EUID -eq 0 ]] && warn "Running as root. A non-root user with sudo is safer."

say "1/7  System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl wget git ca-certificates gnupg xvfb fonts-liberation

say "2/7  Node.js 22 and PM2"
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "    node $(node -v), npm $(npm -v)"
if ! command -v pm2 >/dev/null; then
  sudo npm install -g pm2@latest
fi
echo "    PM2 $(pm2 --version | tail -n 1)"

say "3/7  Google Chrome"
if ! command -v google-chrome-stable >/dev/null; then
  wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get install -y -qq /tmp/chrome.deb
  rm -f /tmp/chrome.deb
fi
echo "    $(google-chrome-stable --version)"

say "4/7  Chrome service on :$CDP_PORT (loopback only)"
mkdir -p "$PROFILE_DIR"
sudo tee /etc/systemd/system/myasis-chrome.service >/dev/null <<UNIT
[Unit]
Description=Myasis automation Chrome
After=network.target

[Service]
Type=simple
User=$USER
# Xvfb gives Chrome a real (virtual) display. Headless mode is what bot
# detection fingerprints, so a virtual display keeps the profile normal.
ExecStart=/usr/bin/xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24 -nolisten tcp" /usr/bin/google-chrome-stable \\
  --remote-debugging-port=$CDP_PORT \\
  --remote-debugging-address=127.0.0.1 \\
  --user-data-dir=$PROFILE_DIR \\
  --window-size=1440,900 \\
  --no-first-run --no-default-browser-check \\
  --disable-dev-shm-usage \\
  about:blank
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now myasis-chrome.service
sleep 5
if curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; then
  echo "    Chrome is listening on 127.0.0.1:$CDP_PORT"
else
  warn "Chrome did not come up. Check: sudo journalctl -u myasis-chrome -n 40"
fi

say "5/7  Application"
if [[ -d "$APP_DIR/seek-bot" ]]; then
  echo "    Found $APP_DIR — installing dependencies"
  ( cd "$APP_DIR/seek-bot" && npm ci --include=dev --silent && npm run build )
  ( cd "$APP_DIR/dashboard" && npm ci --include=dev --silent && npm run build )
else
  warn "No app at $APP_DIR yet. Copy it up, then re-run this script:"
  echo "      rsync -av --exclude node_modules --exclude dist \\"
  echo "        ./seek-bot ./dashboard ./profile.txt ./ecosystem.config.cjs $USER@$(hostname -I | awk '{print $1}'):$APP_DIR/"
fi

say "6/7  Configuration"
ENV_FILE="$APP_DIR/seek-bot/.env"
if [[ -f "$ENV_FILE" ]]; then
  set_env() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$ENV_FILE"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
      printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
    fi
  }
  set_env CDP_HOST 127.0.0.1
  set_env CDP_PORT "$CDP_PORT"
  set_env BROWSER_CONNECT_CDP true
  set_env CHROME_PROFILE_DIR "$PROFILE_DIR"
  set_env CHROME_PATH /usr/bin/google-chrome-stable
  set_env PROFILE_PATH "$APP_DIR/profile.txt"
  echo "    Updated $ENV_FILE"
  grep -q '^GEMINI_API_KEY=.\+' "$ENV_FILE" || warn "GEMINI_API_KEY is empty — set it before running."
else
  warn "No .env yet — copy seek-bot/.env.example to .env and fill it in."
fi

say "7/7  PM2 dashboard service"
if [[ -f "$APP_DIR/ecosystem.config.cjs" ]]; then
  # Keep the app on loopback. A reverse proxy should own public TLS and access.
  ( cd "$APP_DIR" && HOST=127.0.0.1 PORT=5180 pm2 startOrReload ecosystem.config.cjs --update-env )
  sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null
  pm2 save
  echo "    PM2 will restore Myasis after a reboot"
else
  warn "No ecosystem.config.cjs found in $APP_DIR; PM2 was not started."
fi

cat <<DONE

────────────────────────────────────────────────────────────
 Setup complete.

 Dashboard status and logs:
     pm2 status
     pm2 logs myasis-dashboard
     pm2 restart myasis-dashboard

 Reach it from your laptop over an SSH tunnel — do NOT open the
 port publicly. Anyone who reaches :$CDP_PORT controls the browser
 and every session logged into it:

     ssh -L 5180:localhost:5180 $USER@<vps-ip>

 Then open http://localhost:5180

 First thing to do there: the Live browser tab → Connect → sign in
 to SEEK, and complete SEEK Pass verification.

 Chrome service:
     sudo systemctl status  myasis-chrome
     sudo systemctl restart myasis-chrome
     sudo journalctl -u myasis-chrome -f
────────────────────────────────────────────────────────────
DONE
