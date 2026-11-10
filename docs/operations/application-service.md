# Application lifetime and dashboard memory

Applications are owned by the `owtomate-applications` PM2 service. The dashboard
uses a private Unix socket and an atomic, private status file under
`seek-bot/data/run-service`. It does not own the worker process tree.

The application service owns browser allocation, the Gmail capability, deadlines,
retry IPC, submission accounting, browser cleanup and result persistence. A
dashboard SIGINT, SIGKILL or memory-limit restart closes viewers and dashboard
sign-in sessions; existing applications continue in the sibling service. A new
dashboard reads the same status and reconnects to the same console/browser.
There is no automatic re-submission or worker re-launch during reconnect.

User Stop and account deletion still stop the selected account, including normal
watchdog escalation. Starting claims are made centrally and released if their
dashboard process dies. Account deletion waits for worker cleanup and excludes
new work in both processes. Stale/unavailable service status is never treated as
an idle account.

Full code deployments still drain active workers before replacing code. Only
then do they refresh the application service. If that service receives a graceful
restart early, it waits for active work instead of calling Stop. A machine reboot,
forced kill of the application service or infrastructure failure is outside the
dashboard-restart guarantee.

## Memory investigation, 10 November 2026

The 08:07 Sydney incident was a PM2 dashboard memory restart: 837,574,656 bytes
RSS exceeded its 786,432,000-byte threshold. The old dashboard shutdown handler
called `runner.stopAll()`, terminating run 1310 with exit 130. Similar dashboard
restarts occurred before the recent visitor-analytics changes.

Inspector allocation sampling reproduced costly run-list polling. The old cost
loader fetched complete ledger event payloads, JSON-copied each event and built
several temporary collections for every refresh. Four production run-list reads
increased dashboard RSS from about 541 MiB to 630 MiB. This demonstrates allocation
pressure and retained allocator capacity; it does not establish a permanent
JavaScript-object leak. The location database also accounts for a stable
126,873,350-byte buffer, rather than growing on each poll.

The replacement aggregates costs in Postgres and transfers one compact total per
run. Active journals are streamed and retain only relevant worker groups. Event
IDs, explicit run identities, legacy ambiguity, incomplete costs and repairs keep
their existing accounting semantics. Against the same latest 150 production run
records, all totals and flags matched. Twelve identical reads in separate,
equally configured processes measured peak RSS of 223.7 MiB before and 179.0 MiB
after. The new process ended near its initial RSS instead of adding about 43 MiB.

Live consoles now have a byte limit as well as a line limit, idle consoles are
released, and slow console sockets disconnect instead of buffering indefinitely.
Complete logs remain on disk. The dashboard retains its 750 MiB PM2 limit, with a
256 MiB JavaScript old-space limit and two allocator arenas to limit transient
heap and native allocator growth. These are memory controls, not application
eligibility rules.

## Validation

Run `bash deploy/check-application-service.sh` on Linux with the application DB
configured. It includes byte-bound/cleanup tests, admission and deletion tests,
11 cost fixtures in a connection-private temporary table, and worker-survival
tests using a fictional application and mailbox. The PM2 integration uses its own
temporary `PM2_HOME`; it triggers a real memory-limit restart, explicit dashboard
restart and SIGKILL recovery. It verifies the same worker PID, a usable Gmail
capability, one receipt/charge/result and working Stop after reconnect. It sends
no real applications or emails and never modifies production ledger records.
