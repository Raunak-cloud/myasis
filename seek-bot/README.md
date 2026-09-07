# seek-bot

Playwright + Gemini agent that searches SEEK, scores listings against your
resume, and completes Quick Apply end to end.

## How SEEK actually works (verified live, Aug 2026)

Worth knowing before you touch the code, because the obvious approach doesn't work:

- **There is no client-side JSON search API to replay.** Results are
  server-rendered. The only runtime GraphQL calls on a results page are a salary
  nudge and a footer banner.
- **The page does expose `window.__APOLLO_CLIENT__`.** Its normalised cache
  holds the hydrated `jobSearchV7` result set — 32 structured job objects per
  page, with `id`, `title`, `abstract`, `advertiser`, `listedAt`, and a
  `cjs.salary` range in integer cents.
- Nested entities are `{__ref: "Type:id"}` pointers that must be dereferenced
  against the store.
- `cjs.salary` carries a real min/max **even when `hideSalary` is true**. This
  bot uses that for *filtering only*. It never reports it as a disclosed figure,
  and never quotes it in an application answer.

So discovery reads the Apollo cache (structured, no selectors), and falls back
to DOM reads via SEEK's own `data-automation` hooks (`jobTitle`, `jobCompany`,
`jobCardLocation`, `jobListingDate`) — far stabler than CSS classes.

## Setup

```bash
npm install
cp .env.example .env      # add GEMINI_API_KEY
```

Sign in to SEEK manually in the Chrome profile at `CHROME_PROFILE_DIR` once.
**The bot never automates login and never handles credentials.** If the session
is dead it stops and tells you.

## Use

```bash
npm run build

node dist/main.js --search-only   # score and shortlist, submit nothing
node dist/main.js --sync          # seed dedupe store from your SEEK history
node dist/main.js                 # search and apply
node dist/probe.js                # diagnose when selectors/schema break
```

Run `--sync` first on a fresh install, or it will re-apply to jobs you already
applied to by hand.

## Pipeline

```
SEEK Recommended (priority) + keyword search (expansion)
        → dedupe + age filter → detail fetch
        → visible CAPTCHA + application-route preflight
        → hard exclusions → keyword score → Gemini fit check
        → Quick Apply state machine → applied.json
```

The signed-in SEEK homepage's personalised Recommended feed is always evaluated
first. Keyword searches expand the pool only after those recommendations, and a
recommendation still has to pass every exclusion, score threshold, and Gemini
fit check before the bot applies.

Before any Gemini fit check, the preflight stops on a visible CAPTCHA and skips
known external applications when external apply is disabled. This prevents
model calls for jobs the current run cannot apply to.

**Hard exclusions** (deterministic, no model call): excluded core stacks,
on-site outside your city, salary below the matching annual/hourly floor, older
than `MAX_AGE_DAYS`.

**Scoring** is seek.md's rubric: 40 skills / 15 title / 15 recency / 15 salary /
10 credibility / 5 location.

**Gemini** does three jobs: judge genuine stack overlap, write grounded cover
letters, and classify pages the state machine doesn't recognise.

### Optional AuthorMist cover-letter pass

Cover letters can be post-processed locally with `authormist-originality`, a
Qwen2.5-3B model trained for meaning-preserving human-style rewriting. It is
not used for fit decisions or application answers. The greeting and sign-off
are preserved, and unchanged, truncated, expanded, or numerically altered
rewrites are rejected.

Install llama.cpp once, then start the quantized local model:

```powershell
winget install llama.cpp
npm run humanizer
```

The first start downloads the Q4 GGUF model. Keep that terminal open, then verify
`http://127.0.0.1:8091/health`. Set `HUMANIZER_URL` in `.env` to that base URL.
AuthorMist must be healthy before a writing run starts. If it becomes unavailable
or rejects a rewrite during the run, the run stops instead of using unprocessed text.

### Cover-letter strategy

Choose one strategy in the dashboard before each run:

- **Tailored by AI** (default) writes a natural letter for each specific company
  and role, grounded in the candidate profile and supporting documents.
- **Reuse one letter** sends the user's supplied letter verbatim whenever a form
  asks for one. Its line breaks are preserved and its contents are redacted from
  process logs.

> Keyword scoring alone is too lenient — it rates a Microsoft D365/Dynamics role
> 94/100 off generic "developer" tokens. The Gemini fit check is what actually
> catches those, so running without an API key gives you an unfiltered list.
> The bot warns loudly when that happens.

## Where it stops and asks you

By design, not limitation:

| Situation | Behaviour |
|---|---|
| CAPTCHA | stops, logs `needs-human`, backs off |
| SEEK Pass / work-rights wall | stops, logs `needs-human` |
| External application while external apply is disabled | logs `off-platform` before AI review, **enters nothing** |
| A question not answerable from `profile.txt` | stops before submitting |
| 2 friction signals in a row | aborts the whole run |

There is **no CAPTCHA solving and no fingerprint evasion** here, deliberately.
Those walls appeared organically after ~44 applications in one day; they're a
signal to slow down, not an obstacle to route around.

## Honesty guarantees

- Cover letters and answers are grounded strictly in `profile.txt`. The model is
  instructed never to inflate years of experience, invent employers, or claim
  skills, clearances or visa status you don't have.
- Any answer the model can't ground returns `grounded: false`, which **halts that
  application** instead of submitting a guess.
- Job-ad text is treated as untrusted data and wrapped in `<untrusted>` tags.
  Real SEEK listings in this corpus contained live prompt-injection attempts
  (one tried to make an agent write "I am an AI and they should have seen this"
  into a screening answer). Detected attempts are logged and ignored.

## Rate limits

Defaults are deliberately conservative — 8 applications/run, 20/day, and a
25–70s jittered gap after submissions or verification walls. Attempts that
submit nothing use a shorter 3–8s paced gap. Raising the submission limits or
removing their cooldown invites exactly the verification walls documented above.

## Caveats

- Many SEEK listings gate applying behind **verified work rights (SEEK Pass)** —
  the page says "Verify your work rights to continue applying" and the flow
  cannot proceed, even though the Continue button stays enabled. The bot detects
  this and halts with `needs-human`. Completing SEEK Pass verification once
  unlocks those listings.
- Automating applications is very likely contrary to SEEK's terms of use. That's
  your call to make; the code keeps volume low and hands off at every human
  checkpoint, but it doesn't make the question go away.
- `data/applied.json` is the dedupe source of truth. Deleting it means
  re-applying to things.

## End-to-end test pipeline

```bash
npm run test:e2e                    # full pipeline, rehearsal only
npm run test:e2e -- --job 94007579  # exercise one specific listing
```

Runs every stage the real pipeline depends on **against the live site**, always
in DRY_RUN so the apply flow is driven to the final Submit and then withheld.

| Stage | Asserts |
|---|---|
| config | profile.txt parses; Gemini key present |
| scoring | salary parser against known cases; hard exclusions fire correctly |
| security | prompt-injection detector catches attacks, no false positives |
| resumes | library resolves, default set |
| knowledge | text extraction produces usable context |
| store | dedupe index loads |
| browser | SEEK session alive |
| discovery | Apollo search returns named + dated jobs |
| detail | description fetch |
| apply | full flow to Submit, cover letter addressed to the right employer |

The apply stage hunts through successive listings for a natively-appliable one,
rather than reporting a hollow "skipped" when the first happens to be an
external ATS. It fails loudly if a dry run ever *submits*.

Mocked tests would not have caught a single one of this project's real bugs —
invisible characters in button labels, Braid radios that never report `checked`,
a modal swallowing pointer events, `$1,100 per day` parsed as an annual salary.
So the harness talks to the real site.
