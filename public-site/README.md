# Owtomate public website

Next.js App Router serves the public homepage, automation guide, blog index and
posts, privacy policy, terms, sitemap and RSS feed. URLs, content and design stay
shared with the existing site. The dashboard, OAuth, payments, browser streams,
application worker and database remain in `dashboard` / `seek-bot`.

The existing server is the same-origin gateway. Requests for public pages and
`/_next/` assets go to Next.js on loopback port 5190. Session-bearing homepage
requests and `/?tab=...` links keep the existing dashboard. APIs, uploaded files,
public media and WebSockets keep their existing routes. Next.js reads only the
allowlisted public-content endpoint, `/api/public/website`; it receives no account
data or database credentials. Live blog publication and website improvements
continue to use the existing backend and appear without rebuilding Next.js.

## Local development

Install dependencies in `seek-bot`, `dashboard`, and this directory. Start the
backend with `PUBLIC_SITE_URL=http://127.0.0.1:5190 npm run dev` in `dashboard`,
then `npm run dev` here. Open the backend origin, normally port 5180. Public pages
are proxied to Next.js; refresh after a change if the backend origin does not
forward Next's development HMR connection.

`npm run build` typechecks and packages a standalone server, including its static
assets. `npm test` starts that build against fixture-only content and checks HTML,
SEO metadata, live patches, redirects, feeds, 404s, CSP/nonces, auth routing and
desktop/mobile interactions. It does not contact employers or start applications.

## Production

Use `deploy/deploy.sh`. It drains active work and performs the existing checks,
then `deploy/public-site.sh` builds and tests Next.js in isolation, copies the
standalone output into `.releases`, and switches `.current` before restarting the
public PM2 process. Running releases keep their own chunks throughout new builds.
Previous release directories remain available for rollback. The dashboard is
restarted with `PUBLIC_SITE_URL` only after the public process is healthy.

Public pages use request-specific CSP nonces. Deployment validates a minimal edit
to the live Caddy configuration so Next.js can supply its nonce policy; all other
responses retain the current default CSP. No inline-script exception is added to
dashboard pages. Keep ports 5180 and 5190 bound to loopback.

The existing Vite public templates remain as content sources and a compatibility
fallback when the gateway is disabled; normal public requests use Next.js. To
roll back the public site, restore `.current` to a previous release and restart
`owtomate-public-site`. To restore legacy public serving, restart the dashboard
with `PUBLIC_SITE_URL` empty. API and worker state require no migration.
