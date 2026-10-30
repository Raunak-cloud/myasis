# Inspecting application errors

In Admin, open a run's **Errors / log** button. The **Errors and recovery** panel shows tool failures, stale targets, nested batch errors, checkpoint-format errors, provider errors/retries, screenshot errors, page crashes, navigation failures, disconnects and run-console errors/warnings. Successful submissions do not hide earlier errors. Expand an entry for details, or open its application attempt's steps and full tool results.

The administrative endpoints check the signed-in administrator before resolving the run's owning account:

- `GET /api/admin/runs/<runId>/diagnostics`
- `GET /api/admin/runs/<runId>/attempts/<attemptUuid>`
- `GET /api/admin/runs/<runId>/log`

For server investigation, the owning account's directory is `seek-bot/data/users/<userId>/`:

- `traces/run-<runId>.diagnostics.jsonl`: append-only structured events. Correlate `runStartId`, `attemptId`, `jobId`, `step`, `tool`, and optional `batchIndex` (zero-based). Events carry timestamps, severity, stage, disposition and sanitized messages/stacks. `attempt_started` and `attempt_finished` events retain the attempt outcome separately from its errors.
- `traces/attempt-<attemptUuid>.json`: atomic, per-attempt steps and existing screenshots. Preparation, candidate-confirmed submission and later retries have different IDs. A started step without `completedAt` identifies an operation with no recorded completion, not proof that it failed or submitted.
- `run-logs/<runId>.jsonl`: console saved incrementally, before limiting the live backlog. Includes startup, search, matching, worker-process, cleanup and persistence failures. It remains available after a crash even if the database run record has no `log_file` yet.
- `traces/<jobId>.json` and `<jobId>.live.json`: compatibility aliases for the latest attempt only. Use the attempt archive for history.

Tool and infrastructure diagnostics are observational. They do not retry a form, judge an answer, submit, change confirmation rules or add model calls. Nested batch failures and stale-reference reinspection are recorded even when execution continues. Follow-up wait warnings do not mean the preceding browser action failed. An error plus a later successful attempt outcome is distinct from an unrecovered failure.

Messages omit secrets and raw page/form payloads; detailed existing traces retain their usual private-data masking and access controls. Browser event callbacks retain their originating account context. Logging failures warn without replacing application outcomes or original exceptions.

Trace retention follows `TRACE_RETENTION_DAYS` (default 14 days), including attempt archives and diagnostic journals. Older runs expose whatever console evidence survives. Preparation traces overwritten before this release cannot be reconstructed, and missing historical diagnostics must not be interpreted as zero errors. No logging system can guarantee persistence after a disk or machine failure.
