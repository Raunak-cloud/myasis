/**
 * Forces rehearsal mode. Import this FIRST, before anything that reads config.
 *
 * Setting `process.env.DRY_RUN` as a statement at the top of a test file does
 * not work: ES module imports are hoisted, so `config.js` evaluates — and
 * snapshots `DRY_RUN` from `.env` — before that statement ever runs. A harness
 * that did exactly that ran with the submit guard disarmed and sent a real
 * application to a live employer.
 *
 * Imports execute in source order, so a side-effecting module imported ahead of
 * config is the reliable way to do this.
 */
process.env.DRY_RUN = 'true';
process.env.REHEARSE = 'true';
