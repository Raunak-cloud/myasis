# Run time limits

Application runs use their existing operator-configured run duration as the
deadline for starting new work. At that deadline, discovery, review admission
and new application claims stop. Applications already in progress on either
worker continue through the normal accuracy, approval, budget and receipt
checks, save their outcomes, and then exit normally. An active application is
not cancelled by the run deadline, and the run does not drain the remaining
queue. Approved email batches follow the same rule.

The dashboard supplies an absolute deadline and requests completion over the
worker's private Node IPC channel. The worker acknowledges it. The absolute
deadline prevents a delayed message from admitting another application;
cooldowns and idle workers are woken without aborting active application work.
A worker that cannot acknowledge within ten seconds falls back to the existing
termination and process-tree cleanup. Manual Stop and dashboard shutdown still
terminate immediately, with forced cleanup after ten seconds if necessary.
Search-queue scans keep their existing hard timeout.

A clean application run exits with code zero and retains its saved prepared
applications and confirmed submissions. The user Activity badge shows
"Finished at time limit" when the deadline is recorded, and Admin shows
"Finished". Genuine application/process failures remain failures. Historical
run results are not rewritten.

Get Owtomated can review up to 200 new jobs per run. Completed matching
decisions are stored permanently per account and vacancy, independently of
run-history retention, model changes, profile changes or advert edits. Later
runs reuse previous matches and skip previous rejections without spending a
new review slot. Failed or malformed reviews and unresolved employer-identity
checks remain retryable. Current application history is checked before reusing
a matching approval. Explicit candidate choices and prepared applications keep
their existing continuation paths.

Auto apply searches and reviews online jobs first. If it finds fewer matches
than the run's available application allowance, it fills the shortfall from
saved matches whose earlier application failed technically. Each saved job is
attempted at most once in that run, without another matching review. Failed
saved forms retain their exact approved content and do not spend another
application credit. Current listing age, selected sources, exclusions, quotas,
personal-question holds and submission history still apply. Semi auto,
search-only scans and explicitly targeted/approved runs do not invoke this
fallback. Interrupted attempts with uncertain send state stay held.

The applying agent retains control through browser recovery. Closed sign-in
popups return to a surviving application page without replaying an action.
Frame, renderer and inspection failures are reported as uncertain browser
evidence so the agent can inspect, switch pages or choose another supported
approach. Repeated-route advice persists through optional recovery narration
until actual progress. It never vetoes an action or forces a retry count.
Verification challenges remain visible to the agent and its configured
verification tools instead of ending the application merely on detection.
Private filling reports matching values as unchanged rather than pretending
to advance the form. The agent can still request a native refill when a widget
needs input events, and chooses the next observed control itself.
Repeated failures, route cycles and evidence-read loops can refresh the same
agent's working conversation. Candidate evidence and prior tool outcomes remain
available as historical data alongside the current page, approvals and saved
work. This does not restart the browser, replay an action, change tools or add
funding. It removes old behavioural examples that can reinforce a failed plan.
An explicit administrator-targeted retry may re-inspect a historical unanswered
question rather than being blocked before the agent opens the form. It does not
provide an answer or change matching, candidate approvals or send authority.
Exact administrator retries support recorded SEEK and Indeed posting IDs. They
use the owner's recorded listing metadata, refetch that posting and retain the
normal matching and applying path. They do not fall back to another job search
or the automatic technical-retry backlog.
Approved applications have no page-URL identity veto. The applying agent verifies
the live employer and vacancy throughout handoffs and before sending. Moving
between an approved entry page and screening does not revoke its approval.

Verification covers admission at the absolute deadline, deadline arrival during
review, worker wakeups, manual Stop during completion, unresponsive-worker
cleanup, and a real child process with two concurrent applications that both
persist their outcomes while a third remains queued.
