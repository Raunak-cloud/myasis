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

Workday, PageUp and SmartRecruiters use growing shared employer directories.
PageUp and SmartRecruiters merge public roots from saved company lists,
application links, the existing job index and Australian public-search results.
Search requests share the index's existing global daily provider allowance;
identical queries are reused across users and new searches are not launched for
approved or targeted application retries. Only public employer identities and
labels are shared, with application paths and tracking values removed.

Each eligible run receives an owner-local directory snapshot. Discovered
companies are added beyond the 20-company manual-list limit. Public search
responses are reused for 30 minutes; job descriptions and application access
are checked fresh. PageUp supports both table and card results, including
same-board redirects between public search/listing pages. Existing matching,
listing-age, duplicate and application allowances still apply. Public discovery
grows coverage over time and cannot guarantee every unindexed or inaccessible
employer is covered.

Run `npm run test:employer-directory` in `seek-bot` and `dashboard` for directory,
public-feed and caching checks. `npm run test:employer-sources-ui` in `dashboard`
checks the company-list controls on desktop and mobile.

## Security

Never commit `.env` files, API keys, browser profiles, candidate profiles, resumes, application history or run logs. These paths are excluded by `.gitignore`.
