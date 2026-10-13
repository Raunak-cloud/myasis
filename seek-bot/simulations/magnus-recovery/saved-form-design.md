# Current saved-form verification

Every forward or final-submit control uses `checkSavedForm` in
`src/agent/tools/gate.ts`. It reads the current fields and validation from
`src/agent/saved-form.ts`, asks Magnus to check that state against candidate
evidence, and rereads the browser to reject a verdict if the state changed.
Equal field captions in different frames have distinct identities.

The old pending, failed and unsupported-fill records remain recovery history
and candidate-question context. They are no longer submission readiness gates.
The former cached prefilled audit, raw-tool-only submit audit and raw-used
flag were removed. A raw click can therefore repair a selection whose visible
text was already correct without leaving a stale pending record blocking it.

Missing and rejected controls go back to Magnus for repair. Missing personal
facts go to the candidate. Unsupported claims allow a repair; a repeated
unsupported claim escalates. Missing or invalid model replies, invented field
identities and verifier outages withhold advancement. Candidate passwords,
OTP controls and hidden input values are excluded from the review.

The saved-form review does not replace vacancy identity/history checks,
submission-attempt tracking, employer receipt verification, dry-run protection,
external-application scope, document selection or time/cost limits.

Validation:

- `npm run test:saved-form`: offline gate regressions.
- `node dist/agent/committed-answers.test.js`: unsupported browser changes.
- `node dist/agent/submit-gate.test.js`: submit classification and dry run.
- `node dist/agent/delayed-receipt.test.js`: delayed receipts and verifier outage.
- `node --test dist/application-identity.test.js`: duplicate protection.
- `npm run test:recovery-sim -- --full-agent-only --repeat 2`: real Magnus loop.
- `node simulations/magnus-recovery/review-saved-form.mjs`: real reviewer.

Build seek-bot first. All fixture tests use isolated fake candidate data and
local forms. Live model tests make paid inference calls but submit no real
applications. Neither the code changes nor simulation results imply that the
change has been deployed to production.
