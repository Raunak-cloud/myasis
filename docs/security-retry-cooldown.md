# Security retry cooldown

An approved application that fails because of a reported employer-site security block receives
an eight-hour `security_retry_after` deadline. The state belongs to the account and saved review,
not to the browser, billing plan, initiating administrator or cover-letter revision.

The read preflight and the row-locked approval claim both enforce the deadline. Only an actual
administrator account owner is exempt. Expiry makes the existing Retry application button
available; it does not start a run, submit anything or guarantee that the employer block cleared.
Ordinary form, credential, mailbox and provider failures do not receive this security cooldown.

The original recorded failure time determines the deadline. Reimports and document edits do not
extend it. Additive migration initializes existing failed reviews from their matching run event,
falling back to the recorded failure update time for legacy rows without an event. It preserves
existing outcome, approval, document, credit and audit fields, and uses an exact timestamp CAS.

The customer sees a disabled countdown and a full local date/time. Browser/server clock offset is
refreshed from the reviews API; the server remains authoritative. The shared customer component
also renders the fictional, local-only preview at **Admin → Simulate → Security retry cooldown**
(`/?tab=admin&adminView=simulate`). Preview controls show
the original block, four hours later and expiry; no API mutation is possible from this preview.

Validation covers direct/concurrent requests, owner separation, admin exemption, reimport/edit
stability, ordinary failures, single-use claims after expiry, applied clearing, migration idempotency,
desktop/mobile display, clock offset, refresh stability and the preview's absence of writes.

Concurrency reference: https://www.postgresql.org/docs/current/explicit-locking.html .
