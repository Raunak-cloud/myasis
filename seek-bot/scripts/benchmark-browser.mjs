/** Run from seek-bot. Results stay in private data/browser-benchmarks. */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
const require = createRequire(import.meta.url);
const root = process.cwd();
const live = process.argv.includes('--live');
const ownerId = process.argv.find(arg => arg.startsWith('--user='))?.slice(7);
const trialCount = Number(process.argv.find(arg => arg.startsWith('--trials='))?.slice(9) ?? (live ? 8 : 24));
if (!Number.isInteger(trialCount) || trialCount < 4 || trialCount > 40) throw new Error('Use 4–40 trials');
const env = { ...dotenv.parse(readFileSync(resolve(root, '.env'))), ...process.env };
const directory = resolve(root, 'data/browser-benchmarks', `${Date.now()}-${live ? 'live' : 'fixture'}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
let preferences = { KEYWORDS: 'Software Engineer', SEARCH_RADIUS_KM: '0', SEARCH_LOCATION: '', MAX_AGE_DAYS: '14' };
let chrome;
const lock = resolve(root, '../.deploying');
let locked = false;
function activeBrowserOrRun() {
  if (process.platform !== 'linux') return false;
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).some(pid => {
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return /dist\/(main|queue)\.js/.test(command) || (chrome && command.includes(`--user-data-dir=${chrome}`));
    } catch { return false; }
  });
}
try {
  if (live) {
    if (!ownerId || !/^\d+$/.test(ownerId)) throw new Error('--user=<admin account id> required');
    const { Pool } = require('../../dashboard/node_modules/pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    try {
      const owner = (await pool.query('SELECT email FROM users WHERE id=$1 AND blocked_at IS NULL', [ownerId])).rows[0];
      if (!owner || !(env.ADMIN_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).includes(owner.email.toLowerCase())) throw new Error('Live benchmark is restricted to an administrator-owned account');
      const rows = (await pool.query("SELECT key,value FROM settings WHERE user_id=$1 AND key IN ('KEYWORDS','SEARCH_RADIUS_KM','ONSITE_CITY','MAX_AGE_DAYS')", [ownerId])).rows;
      preferences = { ...preferences, ...Object.fromEntries(rows.map(row => [row.key, row.value])) };
      preferences.SEARCH_LOCATION = preferences.ONSITE_CITY ?? '';
    } finally { await pool.end(); }
    chrome = resolve(root, 'data/users', ownerId, 'chrome');
    if (!existsSync(chrome)) throw new Error('Administrator Chrome profile not found');
    // The existing deployment lock prevents dashboard starts. Never close an active browser.
    writeFileSync(lock, `read-only browser benchmark ${directory}\n`, { flag: 'wx' });
    locked = true;
    await new Promise(done => setTimeout(done, 2000));
    if (activeBrowserOrRun()) throw new Error('An account run or this browser profile is busy; retry after it finishes');
  }
  const results = [];
  for (let i = 0; i < trialCount; i++) {
    // ABBA alternation controls some order/cache effects. Same profile, never concurrent.
    const headless = [false, true, true, false][i % 4];
    const data = resolve(directory, `trial-${i + 1}`);
    mkdirSync(data, { mode: 0o700 });
    const output = resolve(data, 'result.json');
    const profile = live ? chrome : resolve(directory, headless ? 'headless-profile' : 'headed-profile');
    const profilePath = live ? resolve(root, 'data/users', ownerId, 'profile.txt') : resolve(data, 'profile.txt');
    if (!live) writeFileSync(profilePath, 'Full name: Benchmark Fixture\nExpected annual salary: 100000\n');
    const child = spawnSync(process.execPath, ['dist/browser-benchmark.js', ...(live ? [] : ['--fixture'])], {
      cwd: root, encoding: 'utf8', timeout: live ? 300_000 : 60_000,
      env: { ...env, ...preferences, DISPLAY: env.DISPLAY ?? ':99', HEADLESS: String(headless), BROWSER_CONNECT_CDP: 'false', CHROME_PROFILE_DIR: profile, PROFILE_PATH: profilePath, DATA_DIR: data, BENCHMARK_OUTPUT: output, CDP_PORT: '19444', DRY_RUN: 'true', CAPTCHA_SOLVER: 'off', BRIGHTDATA_ADMIN_ENABLED: 'false', BRIGHTDATA_BROWSER_ENABLED: 'false', SEEK_BASE: live ? (env.SEEK_BASE ?? 'https://www.seek.com.au') : 'https://benchmark.invalid' },
    });
    if (!existsSync(output)) {
      // Do not print provider credentials or raw browser launch command lines from stderr.
      results.push({ mode: headless ? 'headless' : 'headed', ok: false, processExit: child.status, error: child.error?.code ?? 'worker did not produce results' });
    } else results.push(JSON.parse(readFileSync(output)));
    writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ live, trialCount, preferences, results }, null, 2));
    const last = results.at(-1);
    console.log(JSON.stringify({ trial: i + 1, mode: last.mode, ok: last.ok, totalMs: last.totalMs, meanPssMiB: last.meanPssMiB, error: last.error }));
    if (child.error || child.status !== 0 || last.challenges > 0 || (last.httpErrors?.length ?? 0) > 0 || !last.ok) {
      console.log('Benchmark stopped after a failure/block; no automated retries.');
      break;
    }
  }
  console.log(`RESULTS=${resolve(directory, 'results.json')}`);
} finally {
  if (locked) unlinkSync(lock);
}
