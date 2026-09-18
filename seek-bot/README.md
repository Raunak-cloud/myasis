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
Employer-site authentication is completed in the candidate's isolated browser.
The bot uses their email, a private site-specific password and connected Gmail
for emailed codes. Australian government and payment destinations stay blocked.

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
| CAPTCHA / SEEK Pass | Attempts automated recovery; an unresolved technical wall skips the job without creating user attention |
| Off-platform | Leaving SEEK with external apply disabled halts before anything is entered |
| Employer authentication | Uses the candidate email, a unique site-specific credential and connected Gmail OTPs; payment and Australian government destinations remain blocked |
| Budgets | Step, wall-clock and per-application USD ceilings. An agent loop has no natural stopping point |
| Success | Only `detectConfirmation()` can report `applied`. The agent is explicitly forbidden from declaring success, and an unconfirmed claim is skipped |

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

Cover letters can be post-processed with `authormist-originality`, a
Qwen2.5-3B model trained for meaning-preserving human-style rewriting. It is
not used for fit decisions or application answers. Unchanged, truncated,
expanded, or numerically altered rewrites are rejected.

**Hosted (recommended): [Featherless](https://featherless.ai/docs).** An
OpenAI-compatible API that serves the model under its Hugging Face id:

```
HUMANIZER_URL=https://api.featherless.ai
HUMANIZER_API_KEY=<your Featherless key>
HUMANIZER_MODEL=authormist/authormist-originality
```

Readiness is one request to the model's own record, which refuses a bad key
and says whether the model is warm; a cold model counts as not ready, because
warming takes minutes. Featherless counts requests in flight against the plan
(this 3B model costs 1 unit; the $25 plan has 4) and answers 429 above it, so
a refused request waits and retries inside the rewrite's time budget, as do
500 and 503. Featherless states it does not log prompts or completions.

**Self-hosted: llama.cpp.** `winget install llama.cpp`, then `npm run humanizer`
(the first start downloads the Q4 GGUF). Use `HUMANIZER_URL=http://127.0.0.1:8091`,
`HUMANIZER_MODEL=authormist-originality` and no key; readiness is its `/health`.
It can also be named as `HUMANIZER_FALLBACK_URL`, tried whenever the hosted API
is not ready. The API key is only ever sent to `HUMANIZER_URL`.

Startup health is required only when `HUMANIZER_REQUIRED=true`. The default
selective pass runs when the draft requests editing; `HUMANIZER_MODE=always`
forces it. Rewrites get two attempts within `HUMANIZER_REWRITE_BUDGET_MS`. A
failed rewrite or failed factual check falls back to the original checked draft.
`src/humanizer-endpoint.ts` holds all of this and is shared with the dashboard;
`npm run test:humanizer-endpoint` exercises it against a local stand-in.

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

## When it asks you

By design, not limitation:

| Situation | Behaviour |
|---|---|
| CAPTCHA | optionally tries CapMonster Cloud, then skips the job if still blocked |
| Employer sign-in or sign-up | completes the form, uses connected Gmail for emailed codes, then skips if authentication still cannot complete |
| Australian government destination | skips before AI review or application |
| SEEK Pass / work-rights wall | skips the job without creating a user task |
| External application while external apply is disabled | logs `off-platform` before AI review, **enters nothing** |
| A required question not answerable from the verified profile | stops before submitting and asks the candidate |
| 2 friction signals in a row | aborts the whole run |

### Optional CapMonster Cloud integration

Set `CAPTCHA_SOLVER=capmonster` and `CAPMONSTER_API_KEY` (from dash.capmonster.cloud)
to solve challenges through the paid [CapMonster Cloud](https://docs.capmonster.cloud)
API; `off` disables it. One attempt is made per tab and URL, with a 60-second
cooldown, and the bot rechecks the page afterward.

| Challenge | Task sent | How the token is applied |
|---|---|---|
| Cloudflare Turnstile | `TurnstileTask` | `cf-turnstile-response` input + the widget's `data-callback` |
| Cloudflare full-page challenge | `TurnstileTask`, `cloudflareTaskType: token` | the challenge page's own callback |
| reCAPTCHA v2 / Enterprise (checkbox, or invisible once its image challenge opens) | `RecaptchaV2Task` / `RecaptchaV2EnterpriseTask` | `g-recaptcha-response` + the callback in grecaptcha's config |

| reCAPTCHA v3 / Enterprise (opt-in, `CAPMONSTER_RECAPTCHA_V3=true`) | `RecaptchaV3TaskProxyless` | swapped into Google's own `/reload` response |

hCaptcha is not offered by CapMonster and still needs a human. Widgets inside
embedded (iframe) forms are solved for, and written into, that frame.

The full-page challenge only reveals its parameters to a `turnstile.render()`
stand-in, so that one case registers a script on the blocked tab over CDP,
reloads it once, and removes the script. Nothing is injected anywhere else.

reCAPTCHA v3 shows no wall, so it is handled as the browser meets it: the hidden
Google iframe's `/reload` response is paused over CDP on that iframe's own
session, and CapMonster's token replaces Google's. No page script is involved
and no other request is intercepted. grecaptcha abandons a held `/reload` after
about 10 seconds, so a solve not back in 9 is dropped and the browser's own
token goes through. It is off by default for a reason: measured on a live demo,
CapMonster's tokens scored 0.1-0.3 against 0.3-0.7 for this browser's own, and
every check on every page is billed. `CAPMONSTER_V3_SITES` limits it to the
hostnames that need it.

CapMonster receives the page URL and site key, never form contents, and solves
through its own proxies. A token is only ever placed; submitting stays with
the agent's guards. A token the page rejects is reported back to CapMonster,
and an account-level error (bad key, empty balance, banned IP) turns the solver
off for the rest of the run. Each solve waits at most 100 seconds.

Verification: `npm run test:capmonster` drives all three challenge types
against a local stand-in for the API. It spends nothing.

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
  this and skips the job. Completing SEEK Pass verification once
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
