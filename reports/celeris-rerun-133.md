# Celeris production rerun — run 133

## Result

21 September 2026, 23:16–23:21 Sydney time. Account 65 (Raunak), production commit `893e5d8`. Started through the existing admin run API, with the same Celeris-1 navigation and Celeris-1-Magnus recovery configuration, unchanged free-plan limits and no manual form corrections.

185 listings discovered; 10 reviews; one qualifying job: **AI-Native Full Stack Engineer at HowToo**, SEEK job `94350628`. **Zero applications submitted.** The run completed after approximately 5 minutes 14 seconds; the application agent took 15 turns. This was a fresh search, not an identical-job A/B test against the previous two applications.

## Where it slipped

1. **Main blocker: the field tool, not a missing model answer.** At turn 11, the bot tried to fill career history. `Job title` and `Company name` are editable text inputs with suggestion lists. `dom.ts` routes every `role=combobox` through a handler that insists on finding a dropdown option. It returned “The dropdown did not open” for both fields. A read-only live DOM inspection later showed the job-title text had actually been entered. That contradicts the tool's later message that nothing could be entered. We did not independently save this profile, so server acceptance of arbitrary text remains unverified.

2. **Dynamic form changes are not handled safely inside a batch.** The same tool call filled “Still in role” and continued attempting the old end-date fields; the Year selection timed out. Live inspection also found an old date selector and the description textarea sharing ref `f6`. `extractFields()` assigns fresh refs without clearing old ones from controls no longer included. These are code-level targeting and stale-state defects; increasing model intelligence cannot remove them.

3. **Recovery is blocked after two failures.** Turn 12 repeated the same tool path. Turn 13 was refused because the fields had been marked unfillable. Magnus then tried focusing the job-title field, but there was no alternate grounded text-entry operation available. It ended with `cannot_complete` at turn 15. The model wasted a retry, but the tool design deprived it of a useful recovery route.

4. **Cover-letter handling remains inefficient.** The model selected “Write a cover letter” and filled it correctly, then spent turns 5–7 reacting to a selection error before finally continuing. Unlike the earlier WIITY attempt, it recovered here; cover-letter handling did not cause this run's final failure.

5. **Technical failure is still labelled success.** The application outcome is stored as `skipped`; the process exits 0; `run_starts.successful` is consequently true despite zero submissions and a technical blocker. This admin-triggered test does not itself consume the customer's automatic-run quota, but the same classification bug affects onboarding/automatic runs.

## Recommended fixes, in order

- Distinguish editable suggestion inputs from selection-only controls; allow grounded typing, blur/readback and form validation instead of requiring a dropdown selection in every case. Do not assume that retaining text proves server acceptance. The [W3C combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) explicitly allows both arbitrary-text and restricted-choice variants.
- Clear obsolete refs, guarantee unique current refs, and re-observe after an action changes form structure. Stop a batch when controls disappear or change rather than acting against the old field list. Check current visibility and enabled state before each action; see [Playwright actionability](https://playwright.dev/docs/actionability).
- Give the model a bounded alternative recovery path with the same grounded answers; distinguish “our dropdown method failed” from “this field cannot be filled.” Keep protections against invented profile facts.
- Preserve technical-failure outcomes separately from legitimate skips, and base daily-run accounting on that outcome—not only exit code and a summary line.
- Add regression fixtures for optional-suggestion comboboxes, current-role/date transitions, stale-ref collisions, delayed validation, and technical-failure accounting. The existing model-forms tests did not cover these cases.

## Side effects and limits

The bot interacted with the real SEEK application form; no manual correction, submission, code change or deployment was performed during this diagnostic run. The app automatically renewed the next-run search terms to Frontend Developer, Mobile Developer, Python Developer and Backend Developer after the zero-submission result. This is existing app behaviour, not a manual settings edit.

Evidence: production `run-logs/133.jsonl`, `traces/94350628.json`, read-only live DOM snapshots, and the run-133 database record. Relevant implementation: `seek-bot/src/dom.ts`, `seek-bot/src/agent/tools.ts`, `seek-bot/src/agent/guards.ts`, `seek-bot/src/agent/loop.ts`, and `dashboard/server/runner.ts`.

**Conclusion:** this rerun primarily exposed defects in our form-execution and recovery code; it does not justify blaming Celeris alone or promise that a model switch would fix them. No fixes have been implemented in this diagnostic turn.
