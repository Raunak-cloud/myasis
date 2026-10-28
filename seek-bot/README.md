# seek-bot

Patchright + Celeris agent that searches SEEK, scores listings against your
resume, and completes Quick Apply end to end.

## Application decisions

Every account uses the same Agent-only application driver with Celeris Magnus.
The model receives the scoped profile, saved answers, CVs, preferences, browser
state and application history. It writes answers and letters, chooses documents,
recovers form errors, judges duplicate history and verifies receipt itself.
Read-only specialist advice is optional and shares the parent spending budget.
Normal turns use medium reasoning; failed actions receive higher effort.

Every account defaults to a fresh viewport screenshot alongside the normal form
observation for each Magnus decision. Previous observation images are removed
before the next request while their text and action history remain. This applies
to Auto apply, Semi auto preparation and confirmed prepared submissions.
Administrators can explicitly turn screenshots off for comparisons using
**Admin screenshot test → Screenshots each step** on the Apply page. The server
rejects non-admin changes and enables screenshots for normal accounts even when
an older saved setting says off. The worker also defaults to screenshots when
the environment setting is absent.

Run `npm run test:agent-screenshots` for isolated browser/transport checks.
`npm run test:agent-screenshots-live` spends up to the normal per-application
budget on three fictional forms using real Magnus: native fields, a custom
dropdown with radio buttons and a checkbox, and an autocomplete selection.
Browser traffic is restricted to reserved `.invalid` domains, so no real employer
receives an application. The report is `output/screenshot-agent-live.json`.

Account isolation, site access, plan allowances, spending limits, resource
deadlines, dry-run controls and Stop remain infrastructure responsibilities.
Only confirmed applications consume the application allowance. Historical
reservations remain available as advisory evidence without vetoing the agent.

Offline browser fixtures: `node dist/agent/agent-only.test.js`.

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
cp .env.example .env      # add CELERIS_API_KEY
```

Sign in to SEEK manually in the Chrome profile at `CHROME_PROFILE_DIR` once.
Employer-site authentication is completed in the candidate's isolated browser.
The bot uses their email, a private site-specific password and connected Gmail
for emailed codes. Government jobs follow the same candidate-fit rules as other
jobs. Payment destinations stay blocked.

Gmail has two explicit connection methods in Settings. While
`GMAIL_MCP_PUBLIC_ENABLED=false`, normal users authorize their own saved Chrome
Gmail session; admins can select browser Gmail or Google OAuth/MCP. Never
enable public OAuth access before Google approves the requested scopes.
After approval, `GMAIL_MCP_PUBLIC_ENABLED=true` offers normal users OAuth/MCP;
they must explicitly consent in Google before it is used. No silent fallback
between methods occurs. Browser consent is separate from Google SSO on a board.
Both backends run behind the same private per-run MCP gateway, with exact
approval and account isolation enforced on the server. Browser operations
attach only to that account's run's loopback Chrome port, including when an
employer form runs in a separate browser. They close their mailbox tabs after
each operation. Verification bodies are parsed locally, without an AI request.
The OAuth
project needs Gmail API enabled and `gmail.readonly` plus `gmail.send` consent;
Google's verification requirements still apply. The connection reuses the
existing Google sign-in callback. Set `GMAIL_TOKEN_ENCRYPTION_KEY` once on the
server; refresh tokens stay encrypted in Postgres and never reach a worker.
Each run receives a short-lived MCP capability for its own account. Email-only
applications save the recipient, subject, letter and resume for review. Confirmed
OAuth emails send without launching Chrome or repeating model turns; browser
emails use a deterministic compose/upload/send flow in the saved session.
Unknown OAuth sends are reconciled against Sent. An unknown browser send is
held for inspection. Neither path blindly resends an uncertain application.

## Use

```bash
npm run build

node dist/main.js --search-only   # score and shortlist, submit nothing
node dist/main.js --sync          # seed dedupe store from your SEEK history
node dist/main.js                 # search and apply
```

Run `--sync` first on a fresh install, or it will re-apply to jobs you already
applied to by hand.

## Pipeline

```
Date-filtered keyword searches, newest first
        → dedupe + age filter → detail fetch
        → visible CAPTCHA + application-route preflight
        → hard exclusions → keyword score → role-neutral model fit check
        → Quick Apply state machine → applied.json
```

Search depth has no page-count setting or ceiling. Discovery continues within
`MAX_AGE_DAYS` until results end, repeat, or pass the age boundary on a date-ordered
board. Review and application allowances still apply. Date filters are sent where
the provider supports them; publication evidence is checked locally before AI
matching. Listings without a verifiable date still proceed through normal matching
and application; only a confirmed age beyond the selected maximum excludes them.
Unfiltered homepage recommendations are not queried.

Before any role-neutral model fit check, the preflight stops on a visible CAPTCHA and skips
known external applications when external apply is disabled. This prevents
model calls for jobs the current run cannot apply to.

**Hard exclusions** (deterministic, no model call): candidate-specified excluded domains,
on-site outside your city, salary below the matching annual/hourly floor, older
than `MAX_AGE_DAYS`.

**Scoring** is seek.md's rubric: 40 skills / 15 title / 15 recency / 15 salary /
10 credibility / 5 location.

**Models.** Celeris runs everything: `celeris-1` for the short structured calls (fit check, ranking, page classification) and `celeris-1-magnus` for the browser agent, screening answers, pre-submit audits and cover letters. There is no second provider.

### Apply engine: Celeris browser agent

Job-search and application calls share a FIFO request queue across Node processes
on the VPS, including dashboard search suggestions and resume parsing. It holds
at most two requests in flight by default and spaces starts by 100 ms. Configure
`CELERIS_MAX_CONCURRENT_REQUESTS` and `CELERIS_MIN_INTERVAL_MS` against the actual
workspace allowance; these defaults are local pacing, not a provider quota.
Every key for a workspace must use the same `CELERIS_WORKSPACE_ID` and
`CELERIS_QUEUE_FILE` (defaults group the API origin in `data/celeris-queue.sqlite`).
The file contains only opaque tickets and timestamps, never keys or candidate data.
It coordinates one server; multiple hosts would need a shared queue service.

Celeris search-result ranking runs two independent batches concurrently, keeping
the same 20-job batches, prompts, validation and exact-result cache. Results retain
discovery order when scores tie. The shared queue can reduce actual concurrency;
ranking stops dispatching new batches on an outage and drains in-flight requests.
This overlaps ranking requests, without changing discovery or application limits.

A 429 publishes a cooldown for all queued application workers. Retries honor
`Retry-After` (seconds or HTTP date), add exponential jitter, and stay within the
request deadline. A delay longer than the remaining deadline fails without sending
an early retry. Queue entries expire after abandoned waits or crashed processes;
an unavailable/full queue fails closed. Rejected 429s are recorded as zero cost,
while a network timeout remains an unknown possible charge. Marketing research
is outside this queue.

Magnus is the sole applying agent for job-board and employer-site forms. It reads
candidate evidence, authors answers and letters, chooses native browser actions,
handles documents and judges the employer receipt. Screenshots are enabled by
default. There is no separate form filler or receipt-review model.

Normal turns use medium reasoning. Failed actions receive higher effort. Repeated
failures or unchanged form state require a named recovery-plan call followed by
an assessment of fresh browser evidence. The model chooses the diagnosis and
repair; the controller validates the checkpoint contract, permits one correction
request and stops honestly if the contract still cannot be completed. All normal
tools return after the checkpoint. Confirmed receipt judgments can be recorded
without another call even when their response crosses the spending budget.

Semi auto candidate confirmation, duplicate protection, account isolation,
application allowances, dry-run boundaries and hCaptcha skipping remain active.
Application loops have spending and elapsed-time ceilings, not a fixed step cap.
The focused `node dist/agent/submission-control.test.js` uses reserved-domain
browser fixtures and scripted replies, with no real submissions or model calls.

### Application writing

The selected application model writes cover letters and form answers directly.
Shared instructions require plain, natural first-person wording with no em dashes,
metaphors, buzzwords or stock AI phrasing. Claims still go through the existing
evidence checks. There is no separate rewriting provider or rewriting service.

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
| Australian government destination | reviewed and applied under the same candidate-fit rules as other jobs |
| SEEK Pass / work-rights wall | skips the job without creating a user task |
| External application while external apply is disabled | logs `off-platform` before AI review, **enters nothing** |
| Technical questions, project narratives and troubleshooting explanations | AI drafts the answer from documented projects and professional reasoning; undocumented details are framed as a proposed approach |
| An unresolved required critical personal fact or decision | asks the candidate after checking the profile, documents, saved answers and preferences; the applying agent owns this decision |
| Repeated form errors or unchanged values | requires an agent-authored recovery plan and result assessment |

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

- Candidate facts in cover letters and answers use the profile, supporting documents and saved answers. The model is
  instructed never to inflate years of experience, invent employers, or claim
  skills, clearances or visa status you don't have.
- Technical and professional responses may be composed without asking for a personal anecdote.
  Missing historical details are expressed as an approach the candidate would take, never as invented past incidents or results.
- Only an unresolved required critical personal answer creates a candidate task.
  Optional unknown personal fields are left blank; browser or AI failures are repaired or skipped.
- Job-ad text is treated as untrusted data and wrapped in `<untrusted>` tags.
  Real SEEK listings in this corpus contained live prompt-injection attempts
  (one tried to make an agent write "I am an AI and they should have seen this"
  into a screening answer). Detected attempts are logged and ignored.

## Rate limits

Every account has a daily maximum of 100 applications, with available credits and
any lower user-selected daily cap also respected. Each run shares that allowance.

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
| config | profile.txt parses; Celeris key present |
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

### Direct Magnus browser applications

Magnus authors answers, chooses native browser operations, diagnoses failures and judges the employer receipt. The retired automatic filler, custom-widget recipes, answer cache and independent form/receipt reviewers have been removed.

The applying Magnus agent owns personal-answer verification. It compares actual form values and retained wizard answers with the authoritative profile, saved answers, selected CV and enabled supporting documents, corrects conflicts itself, and asks for a required consequential fact only after retrieving the available evidence. Exact employment dates must be explicit; a duration does not establish months or a consecutive work history. Optional unknowns are cleared or use an offered non-disclosure choice. This applies before Auto submission, Semi auto preparation and email drafts; there is no separate fact-review model, citation gate or reviewer budget. Owner-scoped evidence remains available through `read_candidate_evidence`, including pagination for long documents. Semi auto confirmation, application limits, duplicate protection and hCaptcha skip remain separate controls. Run `npm run test:agent-facts-live` to test real Magnus on five fictional, network-isolated forms (uses the configured API budget; never sends to an employer).

Magnus identifies application-transmitting actions in Auto apply and Semi auto, marking every mouse, keyboard, batch, scripted or coordinate send with `sends_application=true`. Authentication, wizard navigation, document uploads and widget selection remain ordinary actions. There is no separate final-send classifier or error fallback that promotes an ordinary click to a submission. Magnus reads the fresh employer response and reports its final receipt judgement with the observed confirmation quote; code records that judgement without a secondary model or later DOM-text receipt check. Pending responses remain uncertain, and the agent must observe an explicit rejection before choosing a retry. Semi auto still enforces candidate approval and exact approved content for marked sends. This is a cooperative agent protocol, not a sandbox for arbitrary JavaScript. Run `node dist/agent/submission-control.test.js` after building for a focused, network-isolated regression test; it makes no real applications or model requests.

`browser_batch` transports up to 12 agent-selected native actions in order. Each action resolves a fresh strict Playwright locator, supports frame/section scopes and optional native waits, and reports actual values, constraints and validation together. An actual error or popup handoff stops the remaining commands. No form fingerprint veto or automatic answer rewriting decides the interaction.

Magnus handles attachments through native `browser_action` / `browser_batch` `set_input_files`, with exact `file_ids` from the candidate inventory or its own created files. It targets the observed file input, or explicitly selects `file_chooser=true` to click an upload trigger and use the native chooser. The retired `upload_document` handler no longer selects, renders or converts documents during attachment. `create_file` renders exactly agent-supplied text into an explicitly requested format and file name; `convert_file` converts only the selected file into an explicitly requested format. Neither operation uploads. There is no default cover-letter upload format, accept-attribute veto, automatic conversion or acceptance verdict. The agent inspects requirements and saved attachments, chooses any recovery, and records the source resume ID and letter via `save_progress` or `prepare_application`. The private file bridge accepts owner-local handles, preserves original bytes, isolates revised renders by content and retains exact candidate-approved file/content access. Browser scripts do not gain host filesystem access. The focused `node dist/agent/agent-file-tools.test.js` requires LibreOffice and Chrome and uses isolated forms with scripted replies, never live applications or AI requests.

Browser scripts execute only in the browser, without host Node/filesystem access. Semi auto retains exact candidate confirmation and uses native controls rather than scripts or coordinate clicks. Account quotas, duplicate filtering, account isolation, dry-run and immediate visible hCaptcha skipping remain in place.

The conversation keeps a stable cacheable prefix until compaction is necessary. Superseded DOM trees are then retired in chunks while candidate facts, exact approval, current draft and agent-authored progress remain. Context-limit and transient generation failures retry with the same live browser and spending meter; browser actions are never replayed by a model retry. Resource ceilings remain unchanged.

Run `npm run test:agent`, `npm run test:native-browser` and `npm run test:saved-form`. These use real browser fixtures with scripted model responses, including five prepared/confirmed applications. Fixture turn counts do not establish live cost or success rates.
