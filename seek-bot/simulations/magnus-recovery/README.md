# Magnus focused recovery simulation

From `seek-bot`, run:

```sh
npm run build
npm run test:recovery-sim
```

The default run makes real Celeris Magnus API calls against eight locally mocked browser challenges, twice each, then runs four trials using the actual application-agent loop. It uses temporary fake candidate data, an isolated browser context per trial, blocked external browser requests, dry-run mode and bounded calls/time/cost. Full-agent fixtures include a local-only submit control; dry-run withholds submission and the control has no network handler. Celeris API credentials are read through the existing config and never written into the report or playground.

Focused trials make inspection the only first-step tool to exercise the feature directly. They test Magnus's use of the new tool, deeper reasoning and verified repair. The full-agent trials do not force tool selection: the actual loop may solve the form using existing tools. The grader measures committed values, cleared validation, preserved unrelated fields and correct safe stopping; it does not trust the model's success statement. Failure is a recorded result, not a reason to alter the expected answer.

A full-agent pass requires the exact saved value, cleared validation, a collapsed dropdown, the unrelated country preserved, and the agent reaching the withheld final-submit step (`rehearsed`). Reopening the dropdown after saving is a strict failure even if the saved answer remains valid. Application-loop time and cost guards are checked between operations; in-flight calls can take the measured totals beyond their configured allowance.

Generated files live in `output/magnus-recovery-simulation/`: `report.html`, `playground.html`, `results.json` and final screenshots. Open the report to review actions, results and failures, or use the playground to manually try the controls. The playground never calls the model. Cost covers all model calls with reported usage, including tool checks and full-agent calls, at configured token rates; it is not a provider invoice.

Options:

```sh
npm run test:recovery-sim -- --repeat 1 --focused-only
npm run test:recovery-sim -- --case iframe --repeat 2
npm run test:recovery-sim -- --headed
npm run test:recovery-sim -- --full-agent-only --repeat 2 --output ../output/magnus-recovery-simulation/full-agent-validation
```

No production flags, accounts, search preferences or running application jobs are changed. Passing these synthetic challenges does not prove every employer form works.

To test the new saved-form reviewer itself with real Magnus calls, run
`node simulations/magnus-recovery/review-saved-form.mjs`. It checks the eight
fixtures before and after known local selections (15 judgments), including
unchanged text with changed validation, frames, shadow roots, missing facts
and a service that never saves. Selection setup in this test is scripted;
the full-agent suite separately tests Magnus choosing its own repair actions.
Results are saved to `output/magnus-recovery-simulation/saved-form-review/reviewer-results.json`.
