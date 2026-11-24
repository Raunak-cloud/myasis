# Myasis

Myasis is an AI-assisted job search and application workspace. It combines a web dashboard, a Patchright-based job agent and a browser extension so users can review opportunities, prepare grounded application answers and keep control of final submissions.

## Components

- `dashboard` - React and Vite interface with a Node-based API layer
- `seek-bot` - TypeScript, Patchright and Celeris job discovery and application workflow
- `extension` - browser assistant for reviewing and filling supported forms
- `deploy` - Nginx configuration and VPS deployment support

## Local setup

1. Copy `seek-bot/.env.example` to `seek-bot/.env` and add your own secrets and local paths.
2. Install and build the agent:

   ```bash
   cd seek-bot
   npm ci
   npm run build
   ```

3. Install and run the dashboard:

   ```bash
   cd dashboard
   npm ci
   npm run dev
   ```

See `dashboard/README.md`, `seek-bot/README.md` and `DEPLOYMENT.md` for detailed configuration, safety controls and deployment instructions.

## Public employer coverage

Greenhouse and Workday runs read the employers’ public job feeds. The shared
directories use known public career sites from settings, application links and
the job index. Each run receives its own directory snapshot. Public feed
snapshots can be reused for up to 30 minutes. Job details are checked fresh
when needed.

Run `npm run test:employer-directory` in `seek-bot` and `dashboard` for directory,
public-feed and caching checks. `npm run test:employer-sources-ui` in `dashboard`
checks the company-list controls on desktop and mobile.

## Security

Never commit `.env` files, API keys, browser profiles, candidate profiles, resumes, application history or run logs. These paths are excluded by `.gitignore`.
