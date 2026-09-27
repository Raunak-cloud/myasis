/**
 * Starts a Myasis run for one account from the command line.
 *
 * It goes through `startRun`, the one path the Apply page, the scheduler and
 * the admin dashboard use: the account's saved settings and plan, employer-site
 * entitlement, allowance, board sign-in checks, the account's network route
 * (its proxy or home tunnel) and the run record. This script used to rebuild
 * those rules itself and drifted — its runs left from the server's own address
 * instead of the account's route, could not be limited to one kind of
 * application, and were never recorded as runs.
 *
 *   npx tsx run-account.mjs <userId> <search|live> [scope=external|hosted] [KEY=VALUE ...]
 *
 * KEY=VALUE narrows the run the way the Apply page's settings do (PLATFORMS,
 * MAX_APPS_PER_RUN, …); only settings the account may change are accepted.
 * Run it with DISPLAY set on the server. Nothing else may be running for the
 * account: the run takes its browser profile.
 */
import { runner } from './server/runner.js';
import { startRun } from './server/start-run.js';
import { one } from './server/db/index.js';

const [userId, mode, ...rest] = process.argv.slice(2);
if (!userId || !['search', 'live'].includes(mode ?? '')) {
  console.error('usage: npx tsx run-account.mjs <userId> <search|live> [scope=external|hosted] [KEY=VALUE ...]');
  process.exit(2);
}

const email = (await one('select email from users where id = $1', [userId]))?.email ?? null;
if (!email) {
  console.error(`no account ${userId}`);
  process.exit(2);
}

let scope;
const clientOverrides = {};
for (const pair of rest) {
  const i = pair.indexOf('=');
  if (i < 1) continue;
  const key = pair.slice(0, i);
  const value = pair.slice(i + 1);
  if (key === 'scope') scope = value;
  else clientOverrides[key] = value;
}

console.log(`account ${userId} (${email}) · mode ${mode}${scope ? ` · scope ${scope}` : ''}`);
for (const [key, value] of Object.entries(clientOverrides)) console.log(`  ${key} = ${value}`);
if (mode === 'live') console.log('\n⚠ LIVE — real applications will be submitted\n');

runner.subscribe(userId, (line) => process.stdout.write(`${line.text.replace(/\s+$/, '')}\n`));

const started = await startRun({ userId, email, mode, trigger: 'admin', scope, clientOverrides });
if (!started.ok) {
  console.error(`could not start (${started.status}): ${started.error}`);
  process.exit(1);
}

// `startRun` returns once the bot is spawned. The run holds its slot until the
// runner has synced its results and written the run record, so wait for that.
await new Promise((done) => {
  const timer = setInterval(() => {
    if (!runner.activeUserIds().includes(userId)) {
      clearInterval(timer);
      done();
    }
  }, 1000);
});

const finalState = runner.stateFor(userId);
console.log(`\nfinished · exit=${finalState.exitCode} · applied=${finalState.applied}`);
process.exit(finalState.exitCode ?? 0);
