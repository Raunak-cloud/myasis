# Headless regression testing

Run from `seek-bot` with Node 22.18+ and installed regular Google Chrome:

```powershell
npm run test:headless-fixtures -- --repeat=3
```

On the production Linux host, run from an isolated checkout as the app user:

```sh
DISPLAY=:99 CHROME_PATH=/usr/bin/google-chrome-stable npm run test:headless-fixtures -- --repeat=3
```

`FIXTURE_OUTPUT` optionally selects the report directory. Each repetition runs
both headed and headless Chrome; the order alternates. The coordinator uses the
app watchdog: a three-minute worker deadline, ten-second termination grace and
forced process-tree termination. It returns nonzero if any worker/check fails.

The 35 checks exercise the production browser launcher, SEEK DOM search/detail
readers, form observation and CAPTCHA recognition against a loopback HTTP server.
Coverage includes Unicode, encoded preferences, pagination, delayed SPA pages,
optional fields, empty DOM results, hosted/external application links, previous
applications, redirects, HTTP 403/429/503, navigation timeouts, connection failure,
challenge visibility and expiry, CDP frames/reconnection, popups, 100 navigations,
persistent sessions, profile isolation and live-view port release.

The matrix creates disposable synthetic profiles and private metrics directories.
It blocks off-host page requests, substitutes synthetic challenge frames, disables
paid solvers and does not click application submits. It asserts no model metrics
or non-GET fixture requests. It never uses customer profiles or changes the admin
pilot setting. Failure screenshots and JSON reports stay in the output directory.

Important boundaries:

- Empty results test the DOM reader, not the AI-assisted wall classification.
- Synthetic CAPTCHA fixtures test recognition, not solver effectiveness.
- Storage isolation tests browser profiles; database isolation has separate tests.
- CDP frames test stream production/reconnection; dashboard waiting/blank/stale
  frame behaviour is checked separately in `dashboard/test/live-action.test.ts`.
- Replacing a working tab keeps another tab open. Closing the last native headed
  window may exit Chrome; continued use then requires a new context.
- A failed navigation can commit Chrome's error page after `goto()` rejects.
  The connection-failure fixture isolates that failed tab before continuing.
- Fixture timings are not estimates of real-job speed, anti-bot acceptance,
  provider bills, long-term memory use or application success.

Additional checks:

```sh
# dashboard (uses fixture APIs; no live submissions)
npm run build
../seek-bot/node_modules/.bin/tsx --test server/browser-run-policy.test.ts server/run-watchdog.test.ts test/live-action.test.ts
../seek-bot/node_modules/.bin/tsx scripts/test-smartrecruiters-ui.mts

# seek-bot
node dist/agent/submit-gate.test.js
node dist/captcha/hcaptcha.test.js
node dist/form-replay.test.js
CHROME_PATH=/usr/bin/google-chrome-stable CELERIS_API_KEY=replay-only node dist/form-replay.js /path/to/recorded/form-corpus
```

Recorded-form replay must use the existing baselines without `--accept`. It
intercepts recorded URLs, aborts other page requests and never sends applications.
Keep detailed replay logs private because recorded pages may contain personal data.

Live discovery benchmarking is separate, read-only and admin-owned. Use the
existing `benchmark-browser.mjs` coordinator with the account's normal network
route and profile leases. Stop on a verification/HTTP failure. Do not switch IPs,
spoof browser identity, retry around blocks, or enable customer headless runs on
the strength of offline fixtures.
