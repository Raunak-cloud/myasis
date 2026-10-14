# Cost optimisation without weaker decisions

The rolling week ending 14 October 2026, 04:17 UTC recorded approximately
US$15.44 of Celeris charges: 59% forms/browser/recovery, 32% job screening,
8% cover letters and 1% other. Historical category attribution uses operation
timings and is approximate; it excludes hosting, humanizer and browser services.
About US$10.15 was uncached input, US$1.05 cached input and US$4.24 output.
Changing only the letter-writing model cannot remove the main costs.

## Exact reuse

`pipeline.cachedAssessment` persists validated screening results under the
account's own `DATA_DIR/fit-cache`. Concurrent identical calls in one process
share a request, keyed by the absolute account path. Rejections release the
entry; invalid results and write failures never become persisted decisions.
Cache hits are recorded with the assessment version in pipeline metrics.

Job ranking now reuses a complete, valid response for 24 hours only when the
entire prompt, schema, model and endpoint match. Candidate facts, constraints,
instructions, listing details, batch order and recent outcomes are part of that
prompt. Incomplete, duplicate, foreign or invalid rankings are not cached.
Changed inputs still go to the same model with the same prompt and budget.

Instruction checking keys its existing seven-day cache by its full prompt and
schema rather than a hand-picked subset of listing properties. This fixes
stale verdict reuse after a salary or work-arrangement change. Uncertain
instruction verdicts continue to be recomputed.

Live form state, saved-form reviews, duplicate checks and submission receipts
are outside this optimisation. No model, reasoning budget, candidate claim or
submission policy changes.

## Validation and measurement

`npm run test:assessment-reuse` uses a fake provider to check concurrency,
restart reuse, owner isolation, expiry, failures and invalidation. It demonstrates
50 simultaneous identical requests producing one computation, not a 98% saving
on real applications. Ranking outage/splitting fixtures and browser form/gate
fixtures check the surrounding paths. No real application is sent by these tests.

Production savings depend on the amount of repeated work. Compare the ledger's
USD per confirmed application, separated by platform/application type, plus
completion rate, unsupported claims, recovery calls and cache-hit counts.
Do not report an estimated saving as a measured invoice reduction.

Further reductions should target browser input/recovery calls first. Prompt or
model changes require matched tests of the same forms and candidate evidence,
including errors, dynamic dropdowns and uncertain submissions, before a rollout.
Celeris documents prefix-dependent caching and variable cache availability:
https://docs.celeris.ai/making-requests#prompt-caching
