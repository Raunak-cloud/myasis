# Model choice for future runs

In Admin, open an account, go to Controls, choose Celeris or MiniMax under
**Future run model**, and click **Save model**. The choice persists across
restarts and applies to future manual, admin-started and scheduled runs. The
whole worker uses that provider for job review, applying and recovery review.
A worker already running retains the environment it started with.

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
