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

Verification covers admission at the absolute deadline, deadline arrival during
review, worker wakeups, manual Stop during completion, unresponsive-worker
cleanup, and a real child process with two concurrent applications that both
persist their outcomes while a third remains queued.
