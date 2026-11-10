import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform !== 'linux') { console.log('PM2 survival integration requires Linux.'); process.exit(0); }
const dir = mkdtempSync(resolve(tmpdir(), 'owtomate-pm2-survival-'));
const environment = { ...process.env, PM2_HOME: resolve(dir, 'pm2'), PM2_WORKER_INTERVAL: '1000' };
const execute = promisify(execFile);
const pm2 = (...args: string[]) => execute('pm2', args, { env: environment, timeout: 30_000, maxBuffer: 1024 * 1024 });
const wait = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) { if (await condition()) return; await new Promise(done => setTimeout(done, 50)); }
  throw new Error('PM2 fixture did not complete.');
};
const loader = resolve(import.meta.dirname, '../../seek-bot/node_modules/tsx/dist/loader.mjs');
const script = resolve(import.meta.dirname, 'test-run-service.mts');
const config = resolve(dir, 'ecosystem.config.cjs');
writeFileSync(config, 'module.exports=' + JSON.stringify({ apps: [
  { name: 'fixture-applications', script, args: '--host', interpreter: process.execPath, node_args: `--import ${loader}`,
    kill_timeout: 10_000, env: { OWTOMATE_RUN_SERVICE_DIR: dir, OWTOMATE_RUN_SERVICE_CLIENT: '0' } },
  { name: 'fixture-dashboard', script, args: '--dashboard start', interpreter: process.execPath, node_args: `--import ${loader}`,
    // Real PM2 memory-limit restart, accelerated only in this private daemon.
    max_memory_restart: '150M', kill_timeout: 3000,
    env: { OWTOMATE_RUN_SERVICE_DIR: dir, OWTOMATE_RUN_SERVICE_CLIENT: '1', FIXTURE_MEMORY_RESTART: '1' } },
] }));
try {
  await pm2('start', config, '--only', 'fixture-applications');
  await wait(() => existsSync(resolve(dir, 'state.json')));
  await pm2('start', config, '--only', 'fixture-dashboard');
  await wait(() => existsSync(resolve(dir, 'dashboard-ready')) && existsSync(resolve(dir, 'worker-pid')));
  const worker = Number(readFileSync(resolve(dir, 'worker-pid'), 'utf8'));
  const firstDashboard = readFileSync(resolve(dir, 'dashboard-ready'), 'utf8');
  await wait(() => existsSync(resolve(dir, 'pm2/pm2.log')) && readFileSync(resolve(dir, 'pm2/pm2.log'), 'utf8').includes('max-memory-restart'));
  await wait(() => readFileSync(resolve(dir, 'dashboard-ready'), 'utf8') !== firstDashboard);
  await pm2('restart', 'fixture-dashboard', '--max-memory-restart', '1G');
  process.kill(worker, 0);
  const appList = async () => JSON.parse((await pm2('jlist')).stdout) as Array<{ name: string; pid: number; pm2_env: { restart_time: number; max_memory_restart: number } }>;
  const before = (await appList()).find(app => app.name === 'fixture-dashboard')!;
  assert.ok(before.pm2_env.restart_time >= 1);
  await pm2('sendSignal', 'SIGKILL', 'fixture-dashboard');
  await wait(async () => {
    const app = (await appList()).find(app => app.name === 'fixture-dashboard');
    return Boolean(app?.pid && app.pid !== before.pid && app.pm2_env.restart_time > before.pm2_env.restart_time);
  });
  process.kill(worker, 0);
  writeFileSync(resolve(dir, 'continue'), 'yes');
  await wait(() => existsSync(resolve(dir, 'result.json')));
  assert.deepEqual(JSON.parse(readFileSync(resolve(dir, 'result.json'), 'utf8')), { charges: 1, completions: 1, applied: 1, code: 0 });
  assert.equal(readFileSync(resolve(dir, 'gmail-survived'), 'utf8'), 'yes');
  assert.equal(Number(readFileSync(resolve(dir, 'worker-pid'), 'utf8')), worker);
  console.log('PASS: real PM2 memory-limit restart, explicit restart and SIGKILL recovery leave the same application worker and Gmail lease alive; exactly one receipt, charge and result. Private PM2 daemon, no real applications.');
} finally {
  await pm2('kill').catch(() => {});
  if (existsSync(resolve(dir, 'worker-pid'))) {
    try { process.kill(-Number(readFileSync(resolve(dir, 'worker-pid'), 'utf8')), 'SIGKILL'); } catch { /* Exited. */ }
  }
  rmSync(dir, { recursive: true, force: true });
}
