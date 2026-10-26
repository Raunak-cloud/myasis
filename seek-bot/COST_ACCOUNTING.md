# Application cost accounting

Administrators see a USD cost column in Applications and a provider breakdown
when opening a row. The normal application API never returns internal costs;
the separate cost API requires an authenticated administrator and always reads
that session's account.

The worker writes an immutable usage journal in its private account directory.
AsyncLocalStorage keeps overlapping fit checks, speculative letter preparation
and browser actions attached to the right job. Celeris records usage centrally
on every response, including unusable generations/retries, whether or not the
caller supplies a budget meter. Cached input and output (including reasoning)
use the published [Celeris rates](https://docs.celeris.ai/pricing).

CapMonster task charges use the response's cost when supplied. Fixed services use optional allocations configured in
Admin > Config > Application cost accounting:

- `APPLICATION_INFRA_USD_PER_WORKER_HOUR`: hosting, proxy, storage, email and
  other fixed service costs divided by expected monthly worker-hours. Exclude
  the separately metered providers.

Missing costs display as unknown, never free. Each event saves the amount and
its basis, so changing future rates does not rewrite recorded history. Journal
import is idempotent on `(user_id, event_id)` and survives partial lines. Costs
remain independent of immutable submission history and therefore retain paid
failed attempts. Run-close sync persists them to PostgreSQL; the read endpoint
also includes the current journal, deduplicated by event ID.

A run's direct job charges belong to its confirmed applications. Shared search,
ranking and unsuccessful attempts are divided equally among those confirmed
applications. A run with no submissions retains costs against the jobs reviewed
in that run. Unrelated scan-only work is not reassigned to historical sends.
Repeated attempts add to the same job. If a run has not closed cleanly or a
charge is unavailable, its total is explicitly partial. Historical applications
without a ledger display “Not recorded”; old console summaries are insufficient
to reconstruct comprehensive costs.

Tests use fixture APIs only, with no real submissions or provider charges:

    cd seek-bot && npm run build && node dist/cost-ledger.test.js
    cd dashboard && npx tsx server/application-costs.test.ts
    cd dashboard && npx tsx scripts/test-application-costs-api.mts
