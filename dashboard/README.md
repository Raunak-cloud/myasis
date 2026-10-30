# Myasis

Weekly, extra and rewritten blogs use Gemini for drafting and source checks, then
publish the approved Gemini prose directly.

Vite + React control panel for the `seek-bot` agent. Read-only viewer over the bot's
own data files — it can display application history but never mutate it.

## Run

```bash
npm install
npm run dev      # http://localhost:5180
```

`npm run build && npm run preview` also serves the API, so the production build
works standalone.

## Resume-based search suggestions

**Suggest from my resumes** returns up to three supported job searches. It reads
the complete selected documents, generates candidates with attributed quotations,
checks each quote against that document, then makes a separate suitability review
covering task relevance, seniority, credentials and overlapping suggestions.
Direct experience is prioritised over transferable experience. Insufficient
evidence can produce fewer suggestions or none; failed verification never returns
unreviewed titles. Oversized documents are rejected explicitly rather than silently
losing their final sections.

The interface shows **Why these suggestions?** with the supporting quotations and
source resume labels. Ordinary suggestions can retain the strongest existing
search. **Find alternatives** explicitly excludes earlier suggestions for the
selected documents; an unsuccessful request preserves existing search terms.
Onboarding and sparse-run renewal use the same verification workflow.

The task-based design follows the [ABS OSCA conceptual model](https://www.abs.gov.au/statistics/classifications/osca-occupation-standard-classification-australia/2024-version-1-0/conceptual-model).
Occupation classifications inform the design; no live taxonomy lookup or licence
registry verification is performed. A separate model review reduces unsupported
inferences but does not guarantee semantic correctness.

From `dashboard/`, run offline checks with
`node ../seek-bot/node_modules/tsx/dist/cli.mjs --test server/search-terms.test.ts`
and the desktop/mobile fixture with
`node ../seek-bot/node_modules/tsx/dist/cli.mjs scripts/test-resume-search-ui.mts`.
The optional `scripts/eval-resume-search.mts` makes live Celeris calls using
fictional resumes only, including unsupported seniority, conflicting credentials,
graduate projects and injected instructions. It consumes provider usage and is
not part of deployment checks.

## Marketing website improvements

The admin Marketing agent can now execute supported improvements on Owtomate's
public homepage, job-application guide, blog index and published blog pages.
Open **Marketing → Website changes** after confirming the website profile and
running a health check. **Prepare website improvements** saves concrete before
and after values. Apply a proposal to change the HTML served to visitors and
crawlers immediately; no rebuild is needed for individual edits.

Supported edits include titles, search/social descriptions, missing H1 headings,
canonical URLs, document language, basic WebPage structured data, invalid JSON-LD
repair, source-backed answer summaries and relevant internal links. Gemini checks
rewritten search text against the existing page; summaries must be exact passages
from that page. The agent samples public URLs after a write and records **Verified**
only when the expected fields are present. A failed public check leaves a visible
**Saved · verification needed** result with retry and rollback controls.

Choose automatic website improvements to apply supported proposals during manual
growth reviews and scheduled weekly cycles. Blog publication follows its separate
approval setting. Each cycle prepares at most five page changes; pausing automatic
improvements or the weekly schedule stops subsequent automatic writes. Original
patches, change history and public verification results are stored in PostgreSQL.
The production preview server applies the idempotent schema upgrade at startup.

Applied edits have rollback controls. Newer page edits cannot be overwritten by
an older proposal or rollback. Legal pages, application screens, crawler policy,
intentional indexing exclusions, broken URLs and image descriptions remain manual
work. External websites remain research/export workspaces until a CMS write
adapter is added; this release implements Owtomate's native adapter first.

Run marketing/blog tests with `../seek-bot/node_modules/.bin/tsx --test
server/marketing/*.test.ts server/blog/*.test.ts`. Set `RUN_MARKETING_DB_TESTS=1`
and point `DATABASE_URL` at a disposable PostgreSQL instance for the migration,
ownership, queue, public-serving and rollback integration tests. These tests use
isolated schemas and remove them afterward.

## Payments and application allowances

The dashboard uses Stripe-hosted Checkout for one-time passes. An application
is deducted only after the bot reports a successful submission; skipped listings, failed forms, off-platform listings,
and items that need attention do not count.

Plans are defined in `src/pricing.ts`. `PLAN_LIMITS` there is what the server enforces and what the plan features are written from:

| Plan | Price | Allowance and access | Validity |
|---|---:|---|---:|
| Free | A$0 | 5 application credits, 1 scheduled run daily, up to 30 jobs reviewed per run, SEEK | Once per account |
| Essential | A$9.90 | 50 application credits, 2 scheduled runs daily, up to 25 jobs reviewed, SEEK, personalised cover letters | 30 days |
| Active Search | A$19.99 | 200 successful applications, 4 automatic runs daily, up to 70 jobs reviewed per run, SEEK and Indeed, priority processing | 30 days |
| Get Owtomated | A$59.99 | Unlimited applications, 4 scheduled runs daily, up to 80 jobs reviewed per run, SEEK, Indeed, advanced controls and supported employer sites | 30 days |
| Application Pack | A$6.90 | 50 successful applications; inherits the active pass end date | Active pass end date |

Passes are one-time payments and do not auto-renew. Existing no-expiry purchases remain grandfathered.

Every plan uses the same natural-writing instructions for cover letters and form
answers: plain language, no em dashes, no metaphors and no stock AI phrasing.

External employer-site applications are enabled only while Get Owtomated
is active. The dashboard injects this entitlement on the server, so a browser
request cannot switch it on. Supported forms reuse the selected resume and
verified profile details, and stop for CAPTCHAs, sign-ins, or unanswerable
questions.

### Stripe setup

Add these values to `../seek-bot/.env`:

```dotenv
APP_BASE_URL=http://localhost:5180
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_AUTOMATIC_TAX=false
```

For local testing, run the Stripe CLI listener and copy its `whsec_...` signing
secret into the environment file:

```bash
stripe login
stripe listen --forward-to localhost:5180/api/billing/webhook
```

Restart the dashboard after changing payment secrets. Use Stripe test mode and
its test card `4242 4242 4242 4242` with any future expiry and CVC. For
production, replace the test secret with a live secret, set `APP_BASE_URL` to the
public HTTPS origin, and register this endpoint in Stripe Workbench:

```text
https://your-domain.example/api/billing/webhook
```

Subscribe the endpoint to `checkout.session.completed` and
`checkout.session.async_payment_succeeded`. The webhook grants allowances
idempotently, and the success page confirms the session for immediate feedback.
Do not expose `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` to the browser.

Run the database migration once after pulling the billing changes:

```bash
curl -X POST http://localhost:5180/api/db/migrate
```

## How it gets data

No separate backend. A Vite middleware plugin (`vite.config.ts`) serves
`../seek-bot/data/` as JSON:

| Route | Source |
|---|---|
| `/api/applications` | `applied.json` |
| `/api/log` | `run-log.jsonl` (parsed, bad lines skipped) |
| `/api/meta` | data dir path + last-modified |

The two projects must sit side by side:

```
prompt-templates/
├── seek-bot/data/     ← written by the bot
└── dashboard/         ← this app
```

Hit **Refresh** after a bot run; data is read fresh per request (`no-store`).

## Blog publishing

Admin → Blog uses the same source research, article draft, fact check and
revision process for the scheduled Monday brief and **Add another blog**.
Extra posts receive their own addresses and appear immediately at `/blog`,
in the RSS feed and in the sitemap. **Rewrite this week's** updates the weekly
brief at its existing address; it does not replace an extra post.

Gemini handles all blog drafting, fact-checking and revisions. Add
`GEMINI_API_KEY` under Config → Weekly blog. `BLOG_GEMINI_MODEL` defaults to
`gemini-3.8-flash`. Blog writing requires a Gemini key; the retired
`BLOG_PROVIDER` setting is ignored on older installs.

Apply `/api/db/migrate` as a signed-in admin after installing this update.
The migration preserves existing posts as weekly briefs and allows separate
extra posts in the same week. Extra-post attempts have their own retry record
and cannot exhaust the scheduled brief's retries. `BLOG_WEEKLY=false` stops
the schedule; manual writing remains available.

## Views

**Applied** — every submitted application: role, company, location, match score,
whether a cover letter was stored, timestamp, and a link to the listing. Sortable
by role, company, score or date. Click any row for the detail drawer.

**Detail drawer** — the full record: salary, work arrangement, listing age at
time of applying, the **verbatim cover letter that was submitted**, every
screening question and answer, the scoring rubric's own reasoning, and a run
history for that job showing each attempt and its outcome.

**Activity** — all 5 outcome types (`applied`, `skipped`, `off-platform`,
`needs-human`, `error`) with filtering, including the model's written
reason for every rejection.

**Insights** — what's actually filtering jobs out (wrong location, stack
mismatch, already applied, salary floor…) and applications per company.

Search covers title, company, location and cover-letter body. Light/dark toggle
in the header.

## A note on cover letters

Letter persistence was added *after* the first application was submitted, so any
record from before it shows "No cover letter recorded" rather than a
reconstruction. That gap is deliberate — the drawer is meant to show what was
genuinely sent to an employer, so it is left blank rather than filled with a
plausible-looking regeneration.

New applications store the letter verbatim.

## Running the bot from the dashboard

The **Run bot** tab drives `seek-bot` as a child process and streams its output
back over server-sent events.

### Modes

| Mode | What it does |
|---|---|
| **Search only** | Scores and shortlists. Never opens an application form. |
| **Live apply** | Submits real applications. Irreversible. |

Each run analyses the signed-in user's **SEEK Recommended** feed first, then
uses the configured search terms to expand the candidate pool. Recommended jobs
still have to pass the same exclusions, score threshold, and AI fit check.

Before starting, choose **Tailored by AI** for a natural, job-specific letter or
**Reuse one letter** to send supplied text verbatim on every form that requests
a cover letter. Reusable letter contents are not written to process logs.

### Controls

Max applications per run, max jobs to evaluate, minimum match score, max listing
age, salary floor, on-site city, and the keyword list. Changes apply to the
current run only; **Save as defaults** writes them back to `seek-bot/.env`.

### Safety

Because a button here sends real applications to real employers:

- **Live runs need explicit confirmation** in the UI, and the API independently
  rejects `mode: "live"` without `confirm: true` — a stray POST cannot fire one.
- **Stop** kills the process tree (the bot owns a Chrome child, so Windows needs
  `taskkill /T`).
- **One run at a time**; a second start returns 409.
- **`CELERIS_API_KEY` is never sent to the browser.** `/api/settings` masks it as
  `set (39 chars)`, and POSTs to that route drop the key so the UI cannot
  overwrite a secret it only ever saw masked.
- The bot's own limits still apply — daily cap, jittered delays, and the
  friction abort that stops a run after two CAPTCHA/verification hits.

### Requirements

- `seek-bot` must be built (`npm run build` there); the runner checks for
  `dist/main.js` and reports clearly if it is missing.
- Chrome must not already be running on the bot's profile, or Patchright cannot
  attach.

### API

| Route | Method | Purpose |
|---|---|---|
| `/api/run` | POST | start (`mode`, `overrides`, `confirm`) |
| `/api/run/stop` | POST | terminate the process tree |
| `/api/run/status` | GET | running state, mode, exit code, count |
| `/api/run/stream` | GET | SSE console (`?since=` to resume) |
| `/api/settings` | GET/POST | read (masked) / write `.env` |

## Files tab — resumes and personal context

### Resume library

Upload multiple resumes (PDF/DOC/DOCX/RTF/TXT), label them, and pick one per run
from the **Run bot** tab — a full-stack resume for React roles, an AI-focused one
for LLM roles.

An important SEEK constraint: **its document picker only lists resumes already on
your SEEK profile.** So the bot resolves a resume in this order:

1. A document on SEEK whose name matches the chosen resume → tick it. Changes
   nothing about your profile.
2. Not there → upload the selected local file to the account's SEEK document
   picker, then use it for the application.
3. If the local file or SEEK upload control is unavailable → the run stops with
   `needs-human`. It never silently applies with the wrong resume.

Deleting a resume here removes the local copy only; it never touches SEEK.

### Personal details the AI can consult

Upload documents (full CV, certifications, visa paperwork, transcripts) or write
free-text notes. Text is extracted from **PDF, DOCX, TXT, MD, JSON and CSV** via
`mammoth` and `pdf-parse-fork`. Items can be toggled on and off; only enabled
ones are sent, capped at ~14k characters.

**Why this matters:** a screening question that `profile.txt` cannot answer
normally halts the run. With a knowledge base, the model answers from your own
documents instead. Verified live:

| Question | Answer | Grounded | From |
|---|---|---|---|
| Fine-tuned LLMs? | Yes — LoRA/QLoRA | ✅ | CV |
| GraphQL experience? | Yes | ✅ | CV |
| Driver licence? | Yes | ✅ | note |
| NV1 clearance number? | N/A, none held | ❌ | *refused to invent* |

The first three would previously have stopped the run. The last still does —
which is the point.

### Trust boundary

These are your own files, so the model may quote facts from them. They are still
labelled **evidence, not instructions**, inside `<candidate-documents>` tags, and
the model is told never to follow directives found inside them. A job ad remains
strictly `<untrusted>`. Anything the model cannot ground in the profile *or* these
documents is still marked ungrounded and halts the application.

## Live browser tab

Streams the automation browser into the dashboard and lets you click and type
into it. Use it to observe the worker and for ordinary interaction. Do not rely
on it for CAPTCHA/security verification: its clicks are synthetic CDP input and
may be rejected even when a person is clicking.

On a local desktop, stop the run and use **Open SEEK login** in the run panel.
Myasis opens ordinary Chrome with the same profile so sign-in and verification
use normal OS input. Close that Chrome window before starting the agent again.
On a VPS, use a secure OS-level remote desktop instead; the button intentionally
refuses to open a second browser alongside the managed CDP Chrome service.

### How it works

Chrome DevTools Protocol, not VNC:

- `Page.startScreencast` emits JPEG frames → WebSocket → `<img>` in the browser.
- Clicks, scrolls and keystrokes go back as `Input.dispatchMouseEvent` /
  `Input.dispatchKeyEvent` / `Input.insertText`.
- Coordinates are rescaled from the displayed image back to page pixels, so
  clicks land where you aim regardless of window size.

No X11/Xvfb/x11vnc to install — it reuses the same debugging port Patchright
already talks to. One wrinkle handled: `startScreencast` only emits on *change*,
so a static page would look like a dead connection. The server primes the view
with a screenshot on connect and re-primes if 3s pass with no frame.

### Configuration

`seek-bot/.env`:

```
CDP_HOST=127.0.0.1
CDP_PORT=9333
```

Read per request, so you can repoint it without restarting the dashboard.

### VPS deployment (Hetzner / DigitalOcean)

```bash
# 1. Chrome, once
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb

# 2. Run it with the debugging port bound to loopback only
google-chrome-stable \
  --remote-debugging-port=9333 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir=$HOME/chrome-profile \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1440,900 &
```

On a headless box add `xvfb-run -a` in front, or `--headless=new` — though a
real (virtual) display keeps the browser fingerprint normal, which matters here.

**Never expose 9333 publicly.** Anyone who can reach it controls the browser and
its logged-in sessions. Bind it to loopback and reach the dashboard over an SSH
tunnel:

```bash
ssh -L 5180:localhost:5180 user@your-vps
```

Then open `http://localhost:5180`. For a permanent setup, put the dashboard
behind a reverse proxy with TLS and authentication — it can start real job
applications, so it is not something to leave open.

### Bandwidth

Roughly 8 KB/s idle, spiking during page loads. Tune with the `quality` and
`width` query params on the WebSocket URL in `src/components/LiveActionViewer.tsx`.
