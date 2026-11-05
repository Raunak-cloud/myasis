# Model choice for future runs

In Admin, open an account, go to Controls, choose Celeris or MiniMax under
**Future run model**, and click **Save model**. The choice persists across
restarts and applies to future manual, admin-started and scheduled runs. The
whole worker uses that provider for job review, applying and recovery review.
A worker already running retains the environment it started with.

An admin can give a single retry a larger application spending allowance through
`oneTime.applicationBudget`, for example `{ "baseUsd": 2, "maximumUsd": 4 }` on
the admin start endpoint. These are USD per application, shared with recovery.
The maximum must be between the base and $10; the base must be at least $0.10.
The choice is recorded in that run's `operator_options` and verified again against
its active owner-bound administrator start before the worker receives it. It
does not change account settings, later-run budgets or submission approval.

Choices are stored in the append-only `application_model_assignments` table,
including administrator attribution. Only the authenticated admin endpoint can
write them; ordinary account settings and posted run settings cannot override
them. Repeated saves of the current choice do not add duplicate audit entries.
Accounts with no assignment keep the existing default. An explicitly authorized
one-time admin model selection can still take precedence for that single run.

The worker reads the latest assignment at launch and receives only the selected
provider's credential. Missing credentials or a failed policy lookup refuse the
run; they do not silently choose another provider. The account settings API and
admin drawer display the same saved model policy.

Verification covers isolated PostgreSQL assignments and audit/rollback, worker
resolution for future starts, active-worker preservation, provider-key isolation,
and the real admin UI with fixture APIs (save, reload, account switching, failures
and mobile layout). No employer application is required to test this control.
