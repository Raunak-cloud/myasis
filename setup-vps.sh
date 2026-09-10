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

say "1/8  System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl wget git ca-certificates gnupg xvfb x11vnc fonts-liberation
# SEEK is an Australian site and the browser must agree with the machine it
# runs on. Set at the OS level rather than overridden inside Chrome: that
# override is one of the seams Cloudflare inspects.
sudo timedatectl set-timezone Australia/Sydney || true

say "2/8  Node.js 22 and PM2"
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "    node $(node -v), npm $(npm -v)"
if ! command -v pm2 >/dev/null; then
  sudo npm install -g pm2@latest
fi
echo "    PM2 $(pm2 --version | tail -n 1)"

say "3/8  Google Chrome"
if ! command -v google-chrome-stable >/dev/null; then
  wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get install -y -qq /tmp/chrome.deb
  rm -f /tmp/chrome.deb
fi
echo "    $(google-chrome-stable --version)"

say "4/8  Virtual display :99 for the browsers"
# One shared display for the runs. Each run launches its own Chrome on its own
# account profile — a single shared browser cannot work now, because Chrome
# locks a profile directory and two accounts would fight over one SEEK session.
#
# Headed Chrome on a virtual display, never headless: headless is precisely
# what bot detection fingerprints, and Patchright cannot hide it.
#
# Sign-in sessions get their own displays (:100 and up), started on demand by
# the dashboard — see dashboard/server/signin.ts.
sudo tee /etc/systemd/system/myasis-xvfb.service >/dev/null <<UNIT
[Unit]
Description=Myasis virtual display
After=network.target

[Service]
Type=simple
User=$USER
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now myasis-xvfb.service
# An older single-browser install leaves this behind; runs no longer use it.
sudo systemctl disable --now myasis-chrome.service 2>/dev/null || true
sleep 2
if [[ -e /tmp/.X11-unix/X99 ]]; then
  echo "    Display :99 is up"
else
  warn "Xvfb did not come up. Check: sudo journalctl -u myasis-xvfb -n 40"
fi

say "5/8  AuthorMist humanizer"
# The rewriter that makes generated application text read like a person wrote
# it. It is a 3B model quantised to ~1.8GB, which is small enough to serve
# from the CPU on a modest box — no GPU, and llama.cpp ships a prebuilt
# static-ish binary, so there is nothing to compile here.
LLAMA_BUILD=b10900
LLAMA_DIR=/opt/llama.cpp
MODEL_FILE="$LLAMA_DIR/models/authormist-originality.Q4_K_M.gguf"
sudo apt-get install -y -qq libgomp1
if [[ ! -x "$LLAMA_DIR/llama-$LLAMA_BUILD/llama-server" ]]; then
  sudo mkdir -p "$LLAMA_DIR"
  sudo curl -sSL -o /tmp/llama.tar.gz     "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_BUILD/llama-$LLAMA_BUILD-bin-ubuntu-x64.tar.gz"
  sudo tar xzf /tmp/llama.tar.gz -C "$LLAMA_DIR" && rm -f /tmp/llama.tar.gz
fi
if [[ ! -f "$MODEL_FILE" ]]; then
  echo "    Downloading AuthorMist (~1.8GB, once)"
  sudo mkdir -p "$LLAMA_DIR/models"
  sudo curl -sSL --retry 3 -o "$MODEL_FILE"     'https://huggingface.co/mradermacher/authormist-originality-GGUF/resolve/main/authormist-originality.Q4_K_M.gguf?download=true'
fi
sudo tee /etc/systemd/system/myasis-humanizer.service >/dev/null <<UNIT
[Unit]
Description=Myasis humanizer (AuthorMist via llama.cpp, CPU)
After=network.target

[Service]
Type=simple
User=$USER
Environment=LD_LIBRARY_PATH=$LLAMA_DIR/llama-$LLAMA_BUILD
ExecStart=$LLAMA_DIR/llama-$LLAMA_BUILD/llama-server \
  --model $MODEL_FILE \
  --host 127.0.0.1 --port 8091 \
  --ctx-size 8192 --threads $(nproc) --n-gpu-layers 0
Restart=on-failure
RestartSec=5
# The browser automation is the product; a rewrite is not. Under memory
# pressure the kernel should take this process rather than Chrome or the
# dashboard, and it must yield CPU to a run instead of competing with it.
OOMScoreAdjust=600
Nice=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable -q --now myasis-humanizer
for _ in $(seq 1 30); do
  curl -sf -m 2 http://127.0.0.1:8091/health >/dev/null 2>&1 && break
  sleep 2
done
if curl -sf -m 5 http://127.0.0.1:8091/health >/dev/null 2>&1; then
  echo "    Humanizer answering on 127.0.0.1:8091"
else
  warn "Humanizer did not come up. Check: sudo journalctl -u myasis-humanizer -n 40"
fi

say "6/8  Application"
if [[ -d "$APP_DIR/seek-bot" ]]; then
  echo "    Found $APP_DIR — installing dependencies"
  ( cd "$APP_DIR/seek-bot" && npm ci --include=dev --silent && npm run build )
  ( cd "$APP_DIR/dashboard" && npm ci --include=dev --silent && npm run build )
else
  warn "No app at $APP_DIR yet. Copy it up, then re-run this script:"
  echo "      rsync -av --exclude node_modules --exclude dist \\"
  echo "        ./seek-bot ./dashboard ./profile.txt ./ecosystem.config.cjs $USER@$(hostname -I | awk '{print $1}'):$APP_DIR/"
fi

say "7/8  Configuration"
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
  # Each run launches its own Chrome on its own account profile. Attaching
  # to one shared browser would ignore those profiles entirely and send
  # every account's applications from whichever SEEK session it held.
  set_env BROWSER_CONNECT_CDP false
  set_env HEADLESS false
  set_env CHROME_PROFILE_DIR "$PROFILE_DIR"
  set_env CHROME_PATH /usr/bin/google-chrome-stable
  set_env PROFILE_PATH "$APP_DIR/profile.txt"
  set_env HUMANIZER_URL http://127.0.0.1:8091
  echo "    Updated $ENV_FILE"
  grep -q '^GEMINI_API_KEY=.\+' "$ENV_FILE" || warn "GEMINI_API_KEY is empty — set it before running."
else
  warn "No .env yet — copy seek-bot/.env.example to .env and fill it in."
fi

say "8/8  PM2 dashboard service"
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
