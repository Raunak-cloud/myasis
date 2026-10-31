# Admin form lab

Open `/forms` directly or select **Admin → Form testing**. The HTML pages,
screenshots, submissions and management API require an active administrator.
Tests use the fictional Alex Morgan profile and generated documents, never a
customer's CV, credits, scheduled runs or submitted-application history.

The three 15-page portals exercise repeated field names, delayed dependent
selectors, committed autocomplete values, conditional questions, shadow
controls, nested frames, multipart uploads, temporary save failures and delayed
receipts. The account portal creates an isolated test account, sends a code to
the launching admin's connected Gmail, and requires reauthentication after a
simulated session expiry. Its password is scrypt-hashed; codes are HMAC-bound,
expire after ten minutes, allow five attempts and cannot be reused. No real
Owtomate or employer account is created. Test mail uses the configured Resend
notification sender and is capped per attempt and per administrator.

**Open manually** creates a separate, fresh attempt. **Run agent** asks for
confirmation, then uses the selected Celeris Magnus or MiniMax M3.1 provider,
the production applying agent and its full tool set. Screenshots stay enabled.
The allowance starts at US$0.20 and may grow to US$0.70 with verified progress;
each test has a 25-minute deadline. Costs, elapsed time, screenshots and recovered
tool errors are shown in the test history. Celeris costs remain estimates.

Tests claim the existing runner capacity and account reservation. They cannot
overlap another run or sign-in for that administrator, exceed the three-lane
server limit, or start during a deployment. Stop and dashboard shutdown use the
existing process-group supervisor. Deployments drain active form workers.

The applying agent retains its existing `.invalid` isolation. A native HTTP
bridge receives original multipart bytes and forwards only the current attempt's
paths to the authenticated form backend. Its short-lived, random capability is
kept in server/worker memory, never URLs, page source or logs. Revoking admin
access invalidates it. Grading answers remain server-side; page scripts receive
control definitions only. The grader validates saved fields and original file
hashes before issuing exactly one receipt. A passed agent test also requires
the agent to report the visible receipt correctly.

Private records live in `seek-bot/data/users/<admin-id>/form-tests/<attempt-id>`.
The latest 30 attempts are shown. Reports survive restarts; interrupted workers
are shown as interrupted. Account deletion removes the owner's files normally.
All launches use the same seed for comparable delays, with fresh IDs and codes.

Focused checks (each bounded below one minute):

```sh
node --test dashboard/server/form-lab/engine.test.mjs
node seek-bot/node_modules/tsx/dist/cli.mjs dashboard/server/form-lab-access.test.ts
node dashboard/scripts/test-form-lab-ui.mjs
node dashboard/scripts/test-form-lab-worker.mjs
node seek-bot/node_modules/tsx/dist/cli.mjs dashboard/scripts/test-form-lab-page.mts
```

The browser check submits all three forms with a test outbox; the worker check
uses a local mocked inference endpoint. Neither spends model credit or sends
real email. A paid live launch must be explicitly confirmed by an admin.
