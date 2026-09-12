/**
 * Starts a Myasis run for one account from the command line.
 *
 * Uses the app's own code path — `runSettingsForUser` for that account's saved
 * search settings and `runner.start` for the per-account data export — so a run
 * started here is identical to one started from the dashboard UI. It exists
 * because /api/run needs that account's signed-in session cookie, which an
 * operator on this machine does not have.
 *
 *   node run-account.mjs <userId> <search|rehearse|live> [KEY=VALUE ...]
 */
import { runner } from './server/runner.js';
import { runSettingsForUser } from './server/settings.js';
import { syncRunResultsToDb } from './server/db/run-sync.js';
import { resolve } from 'node:path';
import { billingStatus, isAdmin, consumeSuccessfulApplication, consumeCompletedRehearsal } from './server/billing.js';
import { one } from './server/db/index.js';
import { applyRunPolicy, entitlementsFor, FINE_TUNING_KEYS } from './server/entitlements.js';

const [userId, mode, ...rest] = process.argv.slice(2);
if (!userId || !['search', 'rehearse', 'live'].includes(mode ?? '')) {
  console.error('usage: node run-account.mjs <userId> <search|rehearse|live> [KEY=VALUE ...]');
  process.exit(2);
}

const adminEmail = (await one('select email from users where id = $1', [userId]))?.email ?? null;
const admin = isAdmin(adminEmail);
const entitlements = await entitlementsFor(userId, adminEmail);
const overrides = applyRunPolicy(
  await runSettingsForUser(userId, { unlimited: admin }),
  entitlements,
  'manual',
);

/**
 * Mirror what `/api/run` does before spawning.
 *
 * Without this the run inherits `ALLOW_EXTERNAL_APPLY` from the environment —
 * i.e. unset — and every external-ATS listing is skipped before the fit check
 * even for an account entitled to them. That silently threw away 44% of the
 * candidate pool on the first 40-job run. The entitlement is decided here, from
 * billing, never from a caller-supplied argument.
 */
const email = adminEmail;
const allowance = await billingStatus(userId, email);
overrides.ALLOW_EXTERNAL_APPLY = admin || allowance.paid.hasActiveIntensivePass ? 'true' : 'false';
/**
 * Employer-site applications are an Intensive Pass feature and cost 10-20x a
 * Quick Apply. An operator of this installation has no ceilings at all: no
 * daily employer-site limit, no allowance deduction, and their own run
 * settings are used as configured rather than clamped.
 */
if (admin) overrides.ADMIN_UNLIMITED = 'true';
else overrides.MAX_EXTERNAL_PER_DAY = allowance.paid.hasActiveIntensivePass ? '5' : '0';

// Admins are exempt from the allowance; everyone else is capped by what remains.
if (mode === 'live' && !isAdmin(email)) {
  const requested = Number(overrides.MAX_APPS_PER_RUN || 1);
  overrides.MAX_APPS_PER_RUN = String(Math.min(requested, allowance.totalRemaining));
}

// CLI arguments last, so an operator can still narrow a run.
for (const pair of rest) {
  const i = pair.indexOf('=');
  const key = pair.slice(0, i);
  if (i > 0 && (entitlements.fineTune || !FINE_TUNING_KEYS.includes(key))) {
    overrides[key] = pair.slice(i + 1);
  }
}

// Re-asserted after the CLI args: a command-line flag must not be able to hand
// an account an entitlement billing did not give it.
if (!admin && !allowance.paid.hasActiveIntensivePass) overrides.ALLOW_EXTERNAL_APPLY = 'false';
if (mode === 'live' && !isAdmin(email)) {
  if (allowance.totalRemaining < 1) throw new Error('No application allowance remaining');
  overrides.MAX_APPS_PER_RUN = String(Math.min(Number(overrides.MAX_APPS_PER_RUN || 1), allowance.totalRemaining));
}

console.log(
  `entitlement: ${isAdmin(email) ? 'admin' : 'standard'} · ` +
    `intensive pass ${allowance.paid.hasActiveIntensivePass ? 'yes' : 'no'} · ` +
    `external applications ${overrides.ALLOW_EXTERNAL_APPLY}`,
);

console.log(`account ${userId} · mode ${mode}`);
for (const [k, v] of Object.entries(overrides).sort()) {
  if (k === 'COVER_LETTER_TEXT_B64' || k === 'AI_INSTRUCTIONS_B64') continue;
  console.log(`  ${k} = ${v}`);
}
if (mode === 'live') console.log('\n⚠ LIVE — real applications will be submitted\n');

runner.subscribe(userId, (line) => process.stdout.write(`${line.text.replace(/\s+$/, '')}\n`));

const usageWrites = [];
const started = await runner.start(mode, overrides, userId,
  () => { const write = consumeSuccessfulApplication(userId); usageWrites.push(write); return write; },
  () => { const write = consumeCompletedRehearsal(userId); usageWrites.push(write); return write; },
);
if (!started.ok) {
  console.error(`could not start: ${started.error}`);
  process.exit(1);
}

// `start` returns as soon as the child is spawned; wait for it to actually end.
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (!runner.stateFor(userId).running) {
      clearInterval(t);
      resolve();
    }
  }, 1000);
});

await Promise.all(usageWrites);
await syncRunResultsToDb(userId, resolve(import.meta.dirname, '../seek-bot/data/users', userId));

const finalState = runner.stateFor(userId);
console.log(`\nfinished · exit=${finalState.exitCode} · applied=${finalState.applied}`);
process.exit(finalState.exitCode ?? 0);
