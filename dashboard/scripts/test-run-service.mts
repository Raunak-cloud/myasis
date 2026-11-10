import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const loader = resolve(import.meta.dirname, '../../seek-bot/node_modules/tsx/dist/loader.mjs');
const pause = (ms = 40) => new Promise(done => setTimeout(done, ms));
const wait = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 750; i++) { if (await condition()) return; await pause(); }
  throw new Error('Fixture condition did not complete.');
};
const branch = process.argv[2];
if (branch === '--worker') {
  const { GmailMcpClient } = await import('../../seek-bot/src/gmail-mcp-client.js');
  const dir = process.env.OWTOMATE_RUN_SERVICE_DIR!;
  writeFileSync(resolve(dir, 'worker-pid'), String(process.pid));
  await wait(() => existsSync(resolve(dir, 'continue')));
  const mailbox = new GmailMcpClient(JSON.parse(process.env.FIXTURE_GMAIL!));
  assert.equal((await mailbox.search('fixture')).length, 1);
  await mailbox.close();
  writeFileSync(resolve(dir, 'gmail-survived'), 'yes');
  console.log('✅ submitted [external] synthetic receipt');
} else if (branch === '--host') {
  delete process.env.OWTOMATE_RUN_SERVICE_CLIENT;
  const { RunPool } = await import('../server/runner.js');
  const { serveRuns } = await import('../server/run-service.js');
  const { GmailMcpService } = await import('../../seek-bot/src/gmail-mcp-service.js');
  const pool = new RunPool(), dir = process.env.OWTOMATE_RUN_SERVICE_DIR!;
  const gmail = new GmailMcpService({ search: async () => [{ id: 'fictional-thread' }], thread: async () => [],
    send: async () => { throw Error('This fixture never sends email.'); } });
  // Replace account export and final DB I/O only. Exercise the real pool,
  // worker wiring, progress/billing callback, watchdog and private Gmail lease.
  const run = Reflect.get(pool, 'forUser').call(pool, 'fixture');
  Object.defineProperty(run, 'disposable', { get: () => false });
  let charges = 0, completions = 0;
  run.start = async (_mode: unknown, _overrides: unknown, port: number) => {
    if (run.occupiesSlot) return { ok: false, error: 'Already running.' };
    const grant = await gmail.grant('fixture', 'fixture@example.invalid');
    run.revokeGmail = grant.revoke;
    run.cdpPort = port;
    run.state = { ...run.state, running: true, mode: 'live', startedAt: new Date().toISOString(), finishedAt: null };
    run.onApplicationSubmitted = () => { charges++; };
    const child = spawn(process.execPath, ['--import', loader, script, '--worker'], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, FIXTURE_GMAIL: JSON.stringify(grant.connection) },
    });
    run.spawnChild(child, 'fixture', dir, 'run');
    return { ok: true };
  };
  run.finishChild = async (_id: string, _dir: string, _kind: string, code: number) => {
    run.revokeGmail?.(); run.revokeGmail = null;
    run.state.running = false; run.state.finishedAt = new Date().toISOString(); run.state.exitCode = code;
    run.child = null; run.cdpPort = null;
    writeFileSync(resolve(dir, 'result.json'), JSON.stringify({ charges, completions: ++completions, applied: run.state.applied, code }));
  };
  const service = await serveRuns(pool);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void service.drain().then(() => gmail.close()).then(() => process.exit(0));
  });
} else if (branch === '--dashboard') {
  const { RemoteRunPool } = await import('../server/run-service-client.js');
  const pool = new RemoteRunPool();
  if (process.argv[3] === 'start' && !pool.stateFor('fixture').running) {
    assert.equal(await pool.claimStart('fixture'), true);
    assert.equal((await pool.start('live', {}, 'fixture')).ok, true);
    await pool.releaseStart('fixture');
    assert.equal(pool.stateFor('fixture').running, true);
  } else {
    assert.equal(pool.stateFor('fixture').running, true);
    assert.equal(await pool.claimStart('fixture'), false, 'reconnected dashboard cannot duplicate a worker');
  }
  writeFileSync(resolve(process.env.OWTOMATE_RUN_SERVICE_DIR!, 'dashboard-ready'), String(process.pid));
  if (process.env.FIXTURE_MEMORY_RESTART === '1') {
    const marker = resolve(process.env.OWTOMATE_RUN_SERVICE_DIR!, 'memory-triggered');
    if (!existsSync(marker)) { writeFileSync(marker, 'once'); Reflect.set(globalThis, 'fixtureMemory', Buffer.alloc(128 * 1024 * 1024, 1)); }
  }
  process.once('SIGINT', () => { void pool.stopAll().then(() => process.exit(0)); });
  setInterval(() => {}, 1000);
} else {
  if (process.platform !== 'linux') { console.log('Linux application service integration runs on Linux.'); process.exit(0); }
  const dir = mkdtempSync(resolve(tmpdir(), 'owtomate-run-survival-'));
  process.env.OWTOMATE_RUN_SERVICE_DIR = dir;
  const children: ChildProcess[] = [];
  const launch = (...args: string[]) => {
    const child = spawn(process.execPath, ['--import', loader, script, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.stderr?.on('data', value => process.stderr.write(value));
    return child;
  };
  try {
    const host = launch('--host');
    await wait(() => existsSync(resolve(dir, 'state.json')));
    let dashboard = launch('--dashboard', 'start');
    await wait(() => existsSync(resolve(dir, 'dashboard-ready')) && existsSync(resolve(dir, 'worker-pid')));
    const worker = Number(readFileSync(resolve(dir, 'worker-pid'), 'utf8'));
    dashboard.kill('SIGINT'); await wait(() => dashboard.exitCode !== null);
    process.kill(worker, 0); assert.equal(host.exitCode, null);
    rmSync(resolve(dir, 'dashboard-ready'));
    dashboard = launch('--dashboard', 'reconnect');
    await wait(() => existsSync(resolve(dir, 'dashboard-ready')));
    dashboard.kill('SIGKILL'); await wait(() => dashboard.signalCode === 'SIGKILL');
    process.kill(worker, 0);
    const { RemoteRunPool, runServiceRequest } = await import('../server/run-service-client.js');
    const client = new RemoteRunPool();
    assert.equal(await runServiceRequest('claimStart', ['another']), true);
    await runServiceRequest('releaseStart', ['another']);
    const lines: string[] = [], unsubscribe = client.subscribe('fixture', line => lines.push(line.text));
    await pause(100);
    writeFileSync(resolve(dir, 'continue'), 'yes');
    await wait(() => existsSync(resolve(dir, 'result.json')));
    await wait(() => lines.some(line => line.includes('submitted')));
    unsubscribe();
    assert.deepEqual(JSON.parse(readFileSync(resolve(dir, 'result.json'), 'utf8')), { charges: 1, completions: 1, applied: 1, code: 0 });
    assert.equal(readFileSync(resolve(dir, 'gmail-survived'), 'utf8'), 'yes');
    assert.equal(Number(readFileSync(resolve(dir, 'worker-pid'), 'utf8')), worker);
    // A fresh dashboard can still stop its own worker through the same service.
    rmSync(resolve(dir, 'continue')); rmSync(resolve(dir, 'result.json'));
    assert.equal((await client.start('live', {}, 'fixture')).ok, true);
    assert.equal((await client.stop('fixture')).ok, true);
    await wait(() => existsSync(resolve(dir, 'result.json')));
    assert.equal(JSON.parse(readFileSync(resolve(dir, 'result.json'), 'utf8')).charges, 1);
    await client.stopForAccountDeletion('72001');
    assert.equal(await client.claimStart('72001'), false);
    await client.finishAccountDeletion('72001', false);
    assert.equal(await client.claimStart('72001'), true);
    await client.releaseStart('72001');
    host.kill('SIGTERM'); await wait(() => host.exitCode === 0);
    console.log('PASS: graceful dashboard restart and crash preserve the same worker, private Gmail access, one receipt/charge/result, reconnect, capacity and Stop. No real applications or emails sent.');
  } finally {
    if (existsSync(resolve(dir, 'worker-pid'))) {
      try { process.kill(-Number(readFileSync(resolve(dir, 'worker-pid'), 'utf8')), 'SIGKILL'); } catch { /* Already exited. */ }
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}
