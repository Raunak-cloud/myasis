# Myasis

Vite + React control panel for the `seek-bot` agent. Read-only viewer over the bot's
own data files — it can display application history but never mutate it.

## Run

```bash
npm install
npm run dev      # http://localhost:5180
```

`npm run build && npm run preview` also serves the API, so the production build
works standalone.

## Payments and application allowances

The dashboard uses Stripe-hosted Checkout for one-time passes. The Free plan
includes 30 completed rehearsals per month, while active paid passes include
unlimited rehearsals. An application is deducted only after the bot reports a
successful submission; skipped listings, failed forms, off-platform listings,
and items that need attention do not count.

Plans are defined in `src/pricing.ts`:

| Plan | Price | Allowance | Validity |
|---|---:|---:|---:|
| Free | A$0 | 10 successful applications + 30 rehearsals | Resets monthly |
| Job Search Pass | A$5.99 | 150 successful applications | 30 days |
| Intensive Pass | A$12.99 | 320 successful applications + supported external sites | 30 days |
| Application Top-up | A$2.99 | 50 successful applications | 30 days |

Passes are one-time payments and do not auto-renew.

External employer-site applications are enabled only while an Intensive Pass
is active. The dashboard injects this entitlement on the server, so a browser
request cannot switch it on. Supported forms reuse the selected résumé and
verified profile details, stop for CAPTCHAs, sign-ins, or unanswerable questions,
and withhold the final submit during rehearsal mode.

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

## Views

**Applied** — every submitted application: role, company, location, match score,
whether a cover letter was stored, timestamp, and a link to the listing. Sortable
by role, company, score or date. Click any row for the detail drawer.

**Detail drawer** — the full record: salary, work arrangement, listing age at
time of applying, the **verbatim cover letter that was submitted**, every
screening question and answer, the scoring rubric's own reasoning, and a run
history for that job showing each attempt and its outcome.

**Activity** — all 6 outcome types (`applied`, `skipped`, `off-platform`,
`needs-human`, `rehearsed`, `error`) with filtering, including Gemini's written
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
| **Rehearse** | Fills every form, writes the cover letter, stops at Submit. |
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
- **`GEMINI_API_KEY` is never sent to the browser.** `/api/settings` masks it as
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

## Files tab — résumés and personal context

### Résumé library

Upload multiple résumés (PDF/DOC/DOCX/RTF/TXT), label them, and pick one per run
from the **Run bot** tab — a full-stack résumé for React roles, an AI-focused one
for LLM roles.

An important SEEK constraint: **its document picker only lists résumés already on
your SEEK profile.** So the bot resolves a résumé in this order:

1. A document on SEEK whose name matches the chosen résumé → tick it. Changes
   nothing about your profile.
2. Not there, and **Allow upload** is on → upload the local file. This *adds a
   document to your SEEK account*, so it is off by default.
3. Not there, and upload is off → the run stops with `needs-human`, naming what
   is actually available. It never silently applies with the wrong résumé.

Deleting a résumé here removes the local copy only; it never touches SEEK.

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
`width` query params on the WebSocket URL in `LiveBrowser.tsx`.
