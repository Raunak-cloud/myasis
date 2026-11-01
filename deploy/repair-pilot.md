# Admin recovery pilot

Only active admin account 1 (`raunak.vision@gmail.com`) is enrolled. Install after
the normal deployment: `bash deploy/install-repair-pilot.sh --enable` as root.
Future deployments refresh the service without resetting its activation time.

The root-owned config is `/etc/owtomate-repair-pilot.json`. Set `enabled` to false
to pause. The broker and dashboard recheck it before work and retries. Scheduled
incidents also require their original schedule to remain enabled.

MiniMax proposes changes in four named browser/file modules, without shell,
browser, candidate text or credential access. A separate review, static checks,
networkless dynamic-user build and fixed regression suite must pass. A compiled
build under `/opt/owtomate-repair-releases` is immutable, revision-bound and expires
after two hours. Generated code never replaces the shared production release.

After the original run finishes, one exact-job admin retry may use that build.
Normal fit, duplicate, account, entitlement and candidate approval gates remain.
Semi auto prepares; confirmed applications retain their exact approved revision.
Missing send evidence, unresolved candidate questions, stopped runs and uncertain
sends block recovery. Existing loaded application workers are never hot-patched.

Limits: one case per original run, two cases per Sydney day, eight coding turns,
three changed files, 100 changed lines, one retry. Coding and review costs are
stored in `repair_pilot_cases`; further calls stop when reported spend exceeds
US$0.50 (an in-flight response can cross that threshold). Provider failures and
unknown usage are recorded rather than treated as zero. Application-agent usage
is separate and retains the account's selected application provider.

Inspect `journalctl -u owtomate-repair-pilot.service` and `repair_pilot_cases`.
Source proposals and validation logs stay in `/var/lib/owtomate-repair/cases`,
root-only. Normal owner-scoped traces and database application outcomes remain
the authority for whether an application was actually prepared or submitted.
