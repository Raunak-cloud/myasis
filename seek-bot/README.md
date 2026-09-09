# seek-bot

Patchright + Gemini agent that searches SEEK, scores listings against your
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
        → hard exclusions → keyword score → role-neutral model fit check
        → Quick Apply state machine → applied.json
```

The signed-in SEEK homepage's personalised Recommended feed is always evaluated
first. Keyword searches expand the pool only after those recommendations, and a
recommendation still has to pass every explicit exclusion and model
fit check before the bot applies.

Before any role-neutral model fit check, the preflight stops on a visible CAPTCHA and skips
known external applications when external apply is disabled. This prevents
model calls for jobs the current run cannot apply to.

**Hard exclusions** (deterministic, no model call): candidate-specified excluded domains,
on-site outside your city, salary below the matching annual/hourly floor, older
than `MAX_AGE_DAYS`.

**Scoring** is seek.md's rubric: 40 skills / 15 title / 15 recency / 15 salary /
10 credibility / 5 location.

**Models.** Celeris runs everything structured — the fit check, resume choice,
page classification and screening answers — measured at **6.8x faster** than
Gemini on those calls (300ms vs 2046ms median, n=70). Gemini keeps cover letters
alone: benchmarked against letters this tool actually sent, `celeris-1` was no
faster (~2.5s vs ~2s) and wrote weaker prose, once claiming weekly availability
the candidate's visa does not allow, while `celeris-1-magnus` wrote well but took
7-10s. `npm run bench:fit` and `npm run bench:letter` reproduce both.

### Apply engine: Celeris browser agent

Every SEEK application is driven by a browser agent on
[Celeris](https://docs.celeris.ai). The hand-written state machine that used to
live in `apply.ts` is gone — there is no toggle and no second path.

**What the agent replaced:** navigation only. The ordered list of button labels
to try, the per-site special cases, the modal-dismissal heuristics, the fixed
step budget. The agent reads each step and decides which control to act on.

**What it does not replace:** anything that decides whether an application may
be transmitted. Those live in `src/agent/guards.ts`, run before and after every
turn, and take no model output as input:

| Rail | Behaviour |
|---|---|
| Submit gate | `canSubmit()` is the only route to a submit click. Dry run withholds; an ungrounded answer blocks; an external submit blocks unless enabled |
| Grounding | Answers still come from Gemini's grounded path. Anything it cannot support is recorded and blocks submission |
| CAPTCHA / SEEK Pass | Detected in code before each turn; halts with `needs-human` |
| Off-platform | Leaving SEEK with external apply disabled halts before anything is entered |
| Forbidden destinations | Login, signup, password, payment and checkout URLs are refused outright — the bot still never touches credentials |
| Budgets | Step, wall-clock and per-application USD ceilings. An agent loop has no natural stopping point |
| Success | Only `detectConfirmation()` can report `applied`. The agent is explicitly forbidden from declaring success, and a claim of one is downgraded to `needs-human` |

**The agent cannot author selectors or code.** Each observation stamps a `ref`
onto every visible control; the tools accept only those refs. The model can act
on what it was just shown, and nothing else.

**Model routing.** `celeris-1` handles the per-step decisions — it is a
diffusion model built for exactly this shape of call (short, structured, tool
-shaped), and its prompt cache bills at a tenth of the uncached rate, which is
why the system prompt and tool definitions sit ahead of anything that varies.
A step that stalls twice escalates to `celeris-1-magnus`, which adds reasoning,
and attaches a screenshot. Cover letters and screening answers stay on Gemini:
those are long-form and grounded against the candidate profile, a different job
from picking the next button.

```bash
npm run test:agent    # guards offline, a live Celeris tool call, and a full
                      # multi-step application against a local fixture site
```

The fixture's controls are labelled "Proceed to the next stage" and "Almost
done" — labels the deterministic matcher recognises none of. That is the case
the agent exists for. The run drives to the final submit and withholds it,
typically in 5 steps for about **$0.0011 per application** (prompt cache warm).

Two things that harness caught, both worth keeping in mind:

- **The agent will claim success if you let it.** An earlier `finish` tool
  offered a `submitted` status and the system prompt told it never to use one;
  on a live run it used it anyway, on an application it had not submitted. The
  status is gone from the schema now. Prose is a request; a schema is a rule.
- **A rehearsal submitted a real application.** `e2e.ts` set
  `process.env.DRY_RUN='true'` at the top of the file and then imported config —
  but ES imports are hoisted, so config had already snapshotted `DRY_RUN=false`
  from `.env` and the withhold guard was silently disarmed. `canSubmit` now
  reads the live environment as well as config, and `rehearsal-env.ts` exists so
  a harness can set that flag before config loads. A safety rail must not be
  defeatable by module ordering.
- **`page.evaluate` needs a `__name` shim under tsx.** esbuild's `keepNames`
  wraps named inner functions in a helper that does not exist in the browser,
  so `extractFields` — and therefore every apply flow, on *both* engines —
  threw "__name is not defined" under `npm run dev`. `launchBrowser` now
  installs a no-op shim; the compiled build never emits the call, so it is
  inert in production.

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
AuthorMist startup health is required only when `HUMANIZER_REQUIRED=true`.
The default selective pass runs when the draft requests editing; `HUMANIZER_MODE=always`
forces it. Rewrites get two attempts within a shared 15-second request deadline.
A failed rewrite or failed factual check falls back to the original checked draft.

### Cover-letter strategy

Choose one strategy in the dashboard before each run:

- **Tailored by AI** (default) writes a natural letter for each specific company
  and role, grounded in the candidate profile and supporting documents.
- **Reuse one letter** sends the user's supplied letter verbatim whenever a form
  asks for one. Its line breaks are preserved and its contents are redacted from
  process logs.

> Keyword scoring alone is too lenient — it rates a Microsoft D365/Dynamics role
> 94/100 off generic "developer" tokens. The role-neutral model fit check is what actually
> catches those, so running without an API key gives you an unfiltered list.
> The bot warns loudly when that happens.

## Where it stops and asks you

By design, not limitation:

| Situation | Behaviour |
|---|---|
| CAPTCHA | optionally tries Cloudflare click solving, then logs `needs-human` if still blocked |
| SEEK Pass / work-rights wall | stops, logs `needs-human` |
| External application while external apply is disabled | logs `off-platform` before AI review, **enters nothing** |
| A question not answerable from `profile.txt` | stops before submitting |
| 2 friction signals in a row | aborts the whole run |

### Optional Patchright CAPTCHA integration

The Python [playwright-captcha](https://github.com/techinz/playwright-captcha)
library connects to the TypeScript bot's existing Patchright tab over CDP.
It supports Cloudflare Turnstile and interstitial click solving without an API key.
reCAPTCHA, unsupported challenges, and unsuccessful attempts still need a human.

Install from the `seek-bot` directory (Python 3.11+ and Git required):

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-captcha.txt
```

On Linux, use `.venv/bin/python` for the pip command. Set `CAPTCHA_SOLVER=click`
in `.env` to enable, or `off` to disable. The bot finds this virtual environment
automatically; `CAPTCHA_PYTHON` can override its interpreter path.
Restart the bot after enabling so Chrome launches with a loopback CDP port
(`CDP_PORT`, default 9222). Choose a different free port for concurrent browsers.
With `BROWSER_CONNECT_CDP=true`, the bridge uses the existing `CDP_HOST` and
`CDP_PORT` instead. No extra Python browser download is needed.

The bridge targets the exact CDP tab ID, performs one solve attempt with a
45-second Python timeout and a 50-second process limit, then disconnects.
Attempts on the same tab and URL have a 60-second cooldown. The bot rechecks
the page afterward. The bridge does not reload forms or invoke an API solver's
form-submission functionality. Rate limits and identity checks remain in place.

Verification: `npm run build` then `node scripts/test-captcha.mjs` runs the real
Python solver against locally fulfilled browser fixtures. It requires Chrome
and the Python dependencies; it does not contact job boards or CAPTCHA services.

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

### Role-neutral pipeline improvements

No occupation, skill list or career path is supplied as a fallback. Configure search
terms or a target role. The model evaluates candidate evidence and transferable skills,
respects explicit instructions, and distinguishes missing evidence from disqualification.
Keyword scores rank jobs but cannot reject them or override model decisions. Accepted
and uncertain decisions receive an independent Magnus review; unresolved uncertainty
is withheld. SEEK match badges cannot bypass that review.

Detail fields are read concurrently and fit requests use a bounded completion queue.
Validated definitive assessments are cached for seven days, keyed by the complete
prompt, evidence, profile, settings and model version. Cover letters and resume choices
share in-flight results and prepare one candidate ahead during the existing cooldown.
Candidate documents and resume contents supply relevant verbatim evidence.

Form writes are read back before being recorded. Rejected values and unsupported
answers block submission until resolved. Progress observes current field values,
validation text and disabled controls. Model retries share a 60-second deadline;
local stage timings are written to the account's ignored `pipeline-metrics.jsonl`.
These changes preserve model-led decisions and browser navigation. Explicit user
constraints, submission limits and verification remain enforced.

Validation: `npm run test:pipeline` uses browser fixtures and a stub model;
`npm run test:fit-live` uses synthetic profiles with real model calls (API cost,
no applications). `npm run test:agent` exercises the browser agent on a local form.
The historical benchmark numbers above are not measurements of this new pipeline.
