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
