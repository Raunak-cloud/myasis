# Deploy Myasis with PM2 on a VPS

Myasis is a stateful Node application, not only a static Vite site. The dashboard
serves API routes, starts the SEEK worker, talks to PostgreSQL, and connects to a
persistent Chrome profile. Run one dashboard instance only.

## 1. Copy the application

On the server, keep the same sibling layout as this repository:

```text
~/myasis/
├── dashboard/
├── seek-bot/
├── profile.txt
├── ecosystem.config.cjs
└── setup-vps.sh
```

Copy `seek-bot/.env.example` to `seek-bot/.env` and fill the secrets before
starting the application. Never commit that file.

## 2. Run the installer

Ubuntu 22.04 or 24.04 is recommended. From the repository root:

```bash
chmod +x setup-vps.sh
APP_DIR="$PWD" ./setup-vps.sh
```

The installer adds Node 22, PM2, Chrome, Xvfb, builds both projects, starts the
dashboard on `127.0.0.1:5180`, and configures PM2 to restore it after a reboot.

## 3. Configure PostgreSQL and application secrets

At minimum, set these values in `seek-bot/.env`:

```dotenv
DATABASE_URL=postgresql://myasis:strong-password@127.0.0.1:5432/myasis
GEMINI_API_KEY=
APP_BASE_URL=https://myasis.example.com
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
OAUTH_REDIRECT_URI=https://myasis.example.com/api/auth/callback/google
CDP_HOST=127.0.0.1
CDP_PORT=9333
BROWSER_CONNECT_CDP=true
CHROME_PATH=/usr/bin/google-chrome-stable
CHROME_PROFILE_DIR=/home/your-user/chrome-profile
PROFILE_PATH=/home/your-user/myasis/profile.txt
```

For payments, also set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Register
`https://myasis.example.com/api/billing/webhook` in Stripe.

Apply the database schema once after PostgreSQL is reachable:

```bash
curl -fsS -X POST http://127.0.0.1:5180/api/db/migrate
```

## 3b. Sign each account in to SEEK

Every account applies from its own SEEK login, so each one has to sign in
once. The bot never asks for or stores a password.

Each account gets its own Chrome profile under
`seek-bot/data/users/<id>/chrome`. On a server there is no screen to sign in
on, so the dashboard opens a private virtual one: **Setup → Sign in to SEEK →
Open SEEK sign-in**. That starts an Xvfb display and a real Chrome on that
account's profile, and streams it to the browser over an authenticated
WebSocket. The person signs in as they normally would, clicks *I'm signed in*,
and the session stays in their profile for every later run.

Keyboard and mouse arrive as ordinary X11 input, which is the reason for a
remote desktop rather than the CDP screencast: protocol-injected keystrokes
are what Cloudflare's challenge is built to reject, and sign-in is the one
moment where being rejected is fatal.

Practical notes:

- The window closes itself after 15 minutes, and closing Chrome inside it ends
  the session too. A forgotten window is a signed-in browser left open.
- An account cannot sign in while its own run is going: Chrome locks a profile
  directory. Stop the run first.
- x11vnc listens on `127.0.0.1` only, with a random password per session, and
  the only route to it is the dashboard's authenticated WebSocket. Never
  publish a VNC port.
- Runs draw on the shared display `:99` (`myasis-xvfb.service`). Sign-in
  sessions take their own displays from `:100` upward.

Set the number of accounts that may run at once to suit the machine, since
each holds a Chrome of roughly 1.2 GB:

```bash
pm2 set myasis-dashboard:MAX_CONCURRENT_RUNS 1   # 4 GB box
```

Or edit `MAX_CONCURRENT_RUNS` in `ecosystem.config.cjs`: 1 on 4 GB, 3 on 8 GB,
6 on 16 GB.

> Upgrading from a single-browser install: runs no longer attach to one shared
> Chrome over CDP. The installer now sets `BROWSER_CONNECT_CDP=false` and
> disables `myasis-chrome.service`. Leaving it on would ignore the per-account
> profiles and send every account's applications from one SEEK session.

## 3c. The AuthorMist humanizer

The installer sets this up as `myasis-humanizer.service`: llama.cpp serving
AuthorMist on `127.0.0.1:8091`, CPU only. The model is a 3B quantised to about
1.8GB, so it needs no GPU — a short rewrite takes roughly five seconds on two
cores, and the unit is niced and OOM-deprioritised so a run always wins the
contest for CPU and memory.

    sudo systemctl status myasis-humanizer
    curl -s http://127.0.0.1:8091/health        # {"status":"ok"}
    curl -s http://127.0.0.1:5180/api/humanizer # {"configured":true,"online":true}

It never listens on anything but loopback, and the dashboard reaches it
through `HUMANIZER_URL` in `seek-bot/.env`.

Applications do not depend on it unless `HUMANIZER_REQUIRED=true`; with it off,
a humanizer that is down costs you the Rewrite text tab and nothing else. Its
RSS looks alarming in `ps` (~3GB) because the model file is mmap'd — those
pages are shared, reclaimable, and not counted in `free`'s used total.

## 4. Keep the public surface safe

Do not expose port 9333. It grants control of the signed-in browser. Port 5180
also starts real job-application runs, so put it behind HTTPS and an additional
access-control layer. `deploy/nginx-myasis.conf` contains the required proxy and
WebSocket settings. Create its password file before enabling the server block:

```bash
sudo apt-get install -y nginx apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd-myasis your-login-name
```

For private access without a public domain:

```bash
ssh -L 5180:127.0.0.1:5180 your-user@your-vps
```

Then open `http://localhost:5180`.

## 5. Operate and update

```bash
pm2 status
pm2 logs myasis-dashboard
pm2 restart myasis-dashboard

cd ~/myasis/seek-bot && npm ci --include=dev && npm run build
cd ~/myasis/dashboard && npm ci --include=dev && npm run build
cd ~/myasis && pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save
```

## Coolify

Coolify deploys applications as Docker containers. PM2 is therefore unnecessary
for its normal deployment path: Coolify already owns restarts, health checks,
logs, and rollouts. Use this PM2 setup directly on a VPS, or create a separate
Dockerfile/Compose deployment for Coolify. Do not run this host installer inside
a Coolify application container.
