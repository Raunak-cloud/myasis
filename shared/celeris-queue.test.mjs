import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { acquireCelerisPermit, celerisRetryDelay, waitForCelerisRetry, closeCelerisQueues } from './celeris-queue.mjs';

const dir = mkdtempSync(join(tmpdir(), 'celeris-queue-'));
const moduleUrl = new URL('./celeris-queue.mjs', import.meta.url).href;
let number = 0;
const envFor = () => ({ CELERIS_QUEUE_FILE: join(dir, `${++number}.sqlite`),
  CELERIS_WORKSPACE_ID: 'fixture-workspace', CELERIS_MAX_CONCURRENT_REQUESTS: '2', CELERIS_MIN_INTERVAL_MS: '0' });
const options = env => ({ endpoint: 'https://inference.celeris.ai/celeris-1/v1', deadline: Date.now() + 10_000, env });
after(() => { closeCelerisQueues(); rmSync(dir, { recursive: true, force: true }); });

const script = `
import { acquireCelerisPermit } from ${JSON.stringify(moduleUrl)};
const env=JSON.parse(process.argv[1]);
for(let i=0;i<2;i++) {
 const p=await acquireCelerisPermit({endpoint:'https://inference.celeris.ai/celeris-1-magnus/v1',deadline:Date.now()+15000,env});
 const at=Date.now();
 const start=process.hrtime.bigint().toString();
 await new Promise(r=>setTimeout(r,80));
 const end=process.hrtime.bigint().toString();
 p.release();
 console.log(JSON.stringify({start,end,at}));
}`;
function child(code, args = []) {
  const process_ = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process_.stdout.on('data', chunk => { stdout += chunk; });
  process_.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    process_.once('error', reject);
    process_.once('close', code_ => code_ === 0 ? resolve(stdout) : reject(new Error(`child ${code_}: ${stderr}`)));
  });
  return { process_, done };
}

test('Retry-After seconds and HTTP dates are lower bounds; malformed values use bounded exponential jitter', async () => {
  const now = Date.UTC(2026, 9, 21);
  assert.equal(celerisRetryDelay('3', 0, now, () => 0), 3000);
  assert.equal(celerisRetryDelay('3', 1, now, () => 0.5), 3700);
  assert.equal(celerisRetryDelay(new Date(now + 5000).toUTCString(), 0, now, () => 0), 5000);
  assert.equal(celerisRetryDelay('invalid', 2, now, () => 0.5), 1400);
  assert.equal(celerisRetryDelay('-1', 0, now, () => 0), 0);
  assert.equal(celerisRetryDelay(null, 100, now, () => 1), 10_000);
  await assert.rejects(waitForCelerisRetry(120_000, Date.now() + 1000), /deadline/);
});

test('FIFO admits two at most and aborted/expired waiters do not block the next caller', async () => {
  const env = envFor(); env.CELERIS_MAX_CONCURRENT_REQUESTS = '1';
  const first = await acquireCelerisPermit(options(env));
  let secondGranted = false;
  const second = acquireCelerisPermit(options(env)).then(p => { secondGranted = true; return p; });
  const cancel = new AbortController();
  const cancelled = assert.rejects(acquireCelerisPermit({ ...options(env), signal: cancel.signal }), /abort/i);
  cancel.abort();
  await cancelled;
  await assert.rejects(acquireCelerisPermit({ ...options(env), deadline: Date.now() + 120 }), /deadline/);
  assert.equal(secondGranted, false);
  first.release();
  const p = await second; p.release(); p.release();
  const next = await acquireCelerisPermit(options(env)); next.release();
});

test('different processes and rotated keys share the cap across both Celeris models', async () => {
  const env = envFor();
  const outputs = await Promise.all([0, 1, 2, 3].map(i => child(script, [JSON.stringify({ ...env, CELERIS_API_KEY: `PRIVATE_KEY_${i}` })]).done));
  const events = outputs.flatMap(output => output.trim().split('\n').flatMap(line => {
    const { start, end } = JSON.parse(line);
    return [{ at: BigInt(start), delta: 1 }, { at: BigInt(end), delta: -1 }];
  })).sort((a,b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.delta - b.delta);
  let active = 0, peak = 0;
  for (const e of events) { active += e.delta; peak = Math.max(peak, active); }
  assert.equal(peak, 2);
  assert.equal(active, 0);
  const bytes = readFileSync(env.CELERIS_QUEUE_FILE).toString('utf8');
  assert.doesNotMatch(bytes, /PRIVATE_KEY|Bearer|messages|profile/);
});

test('one worker’s 429 cooldown delays another process and a separate workspace stays independent', async () => {
  const env = envFor();
  const permit = await acquireCelerisPermit(options(env));
  const start = Date.now(); permit.defer(300); permit.release();
  const worker = child(script, [JSON.stringify({ ...env, CELERIS_API_KEY: 'rotated-key' })]);
  const other = await acquireCelerisPermit(options({ ...env, CELERIS_WORKSPACE_ID: 'different-workspace' }));
  other.release();
  const output = await worker.done;
  assert.ok(JSON.parse(output.trim().split('\n')[0]).at >= start + 300);
  // A cooldown exceeding a caller's deadline causes no admission.
  const p = await acquireCelerisPermit(options(env)); p.defer(500); p.release();
  await assert.rejects(acquireCelerisPermit({ ...options(env), deadline: Date.now() + 120 }), /deadline/);
});

test('request starts are spaced even when no other request remains active', async () => {
  const env = { ...envFor(), CELERIS_MIN_INTERVAL_MS: '180' };
  const first = await acquireCelerisPermit(options(env));
  const start = Date.now(); first.release();
  const second = await acquireCelerisPermit(options(env)); second.release();
  assert.ok(Date.now() - start >= 175);
});

test('a killed worker cannot permanently retain its permit', async () => {
  const env = envFor(); env.CELERIS_MAX_CONCURRENT_REQUESTS = '1';
  const worker = child(`import {acquireCelerisPermit} from ${JSON.stringify(moduleUrl)};
    await acquireCelerisPermit({endpoint:'https://inference.celeris.ai',deadline:Date.now()+10000,leaseMs:1,env:JSON.parse(process.argv[1])});
    console.log('ready'); setInterval(()=>{},1000);`, [JSON.stringify(env)]);
  // Attach a rejection handler before intentionally killing the child.
  const stopped = worker.done.catch(() => {});
  await new Promise(resolve => worker.process_.stdout.once('data', resolve));
  worker.process_.kill('SIGKILL'); await stopped;
  const p = await acquireCelerisPermit(options(env)); p.release();
});

test('an unavailable or full shared queue fails closed without a second allowance', async () => {
  const env = envFor();
  const p = await acquireCelerisPermit(options(env)); p.release();
  const db = new DatabaseSync(env.CELERIS_QUEUE_FILE);
  const { scope } = db.prepare('SELECT scope FROM celeris_workspaces').get();
  const insert = db.prepare("INSERT INTO celeris_requests(id,scope,state,expires,max_active,interval_ms) VALUES (?,?,'waiting',?,2,0)");
  for (let i=0;i<256;i++) insert.run(`fixture-${i}`, scope, Date.now()+10000);
  db.close();
  await assert.rejects(acquireCelerisPermit(options(env)), /queue is full/);
  await assert.rejects(acquireCelerisPermit(options({ ...env, CELERIS_QUEUE_FILE: join(env.CELERIS_QUEUE_FILE, 'impossible.sqlite') })));
  await assert.rejects(acquireCelerisPermit(options({ ...env, CELERIS_QUEUE_FILE: 'relative-queue.sqlite' })), /absolute path/);
});
