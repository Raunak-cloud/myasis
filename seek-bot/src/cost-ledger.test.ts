import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Isolated fixture APIs only: no real provider request, account, or application.
process.env.DATA_DIR = mkdtempSync(resolve(tmpdir(), 'application-cost-test-'));
process.env.COST_TRACKING = 'true';
process.env.CELERIS_API_KEY = 'fixture-key';
const { withJobCost, celerisUsage, recordCost, COST_LEDGER_FILE } = await import('./cost-ledger.js');
const { config } = await import('./config.js');
config.celeris.apiKey = 'fixture-key';
const { celerisChat } = await import('./agent/celeris.js');
const { solveTask } = await import('./captcha/capmonster.js');
const originalFetch = globalThis.fetch;
let attempt = 0;
globalThis.fetch = (async (url: string | URL | Request) => {
  const address = String(url);
  if (address.includes('capmonster') && address.endsWith('createTask')) return Response.json({ errorId: 0, taskId: 123 });
  if (address.includes('capmonster')) return Response.json({ errorId: 0, status: 'ready', solution: { token: 'fixture' }, cost: '0.002' });
  attempt++;
  // A paid, unusable generation followed by a valid answer; both count.
  return Response.json({ usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } },
    choices: [{ finish_reason: attempt === 1 ? 'length' : 'stop', message: { content: 'fixture' } }] });
}) as typeof fetch;
try {
  assert.equal(celerisUsage(null), null);
  assert.equal(celerisUsage({ prompt_tokens: -1, completion_tokens: 2 }), null);
  assert.equal(celerisUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } })?.amountUsd, 0.00018);
  await Promise.all([
    withJobCost('job-a', async () => { await new Promise(done => setTimeout(done, 15)); recordCost({ provider: 'Fixture', amountUsd: 1, basis: 'provider' }); }),
    withJobCost('job-b', async () => { recordCost({ provider: 'Fixture', amountUsd: 2, basis: 'provider' }); }),
  ]);
  await withJobCost('job-c', () => celerisChat({ model: 'celeris-1-magnus', messages: [{ role: 'user', content: 'fixture' }] }));
  await withJobCost('job-g', () => solveTask({ type: 'fixture' }, 5000));
  const events = readFileSync(resolve(config.dataDir, COST_LEDGER_FILE), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.find(e => e.provider === 'Fixture' && e.amountUsd === 1).jobId, 'job-a');
  assert.equal(events.find(e => e.provider === 'Fixture' && e.amountUsd === 2).jobId, 'job-b');
  const ai = events.filter(e => e.provider === 'Celeris');
  assert.equal(ai.length, 2); assert.ok(ai.every(e => e.jobId === 'job-c' && e.amountUsd === 0.00018));
  assert.equal(events.find(e => e.jobId === 'job-g').amountUsd, 0.002);
  assert.ok(!JSON.stringify(events).includes('fixture-key'));
  const interruptedDir = mkdtempSync(resolve(tmpdir(), 'application-cost-exit-'));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { withJobCost, beginCostRequest } = await import(${JSON.stringify(new URL('./cost-ledger.js', import.meta.url).href)});
    withJobCost('interrupted', () => beginCostRequest('Celeris', 'celeris-1-magnus'));
    process.exit(1);
  `], { env: { ...process.env, DATA_DIR: interruptedDir, APPLICATION_INFRA_USD_PER_WORKER_HOUR: '0.5' }, encoding: 'utf8' });
  assert.equal(child.status, 1);
  const exited = readFileSync(resolve(interruptedDir, COST_LEDGER_FILE), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(exited.some(e => e.jobId === 'interrupted' && e.provider === 'Celeris' && e.amountUsd === null));
  assert.ok(exited.some(e => e.provider === 'Infrastructure' && e.amountUsd >= 0 && e.unit === 'worker hours'));
  console.log('Cost ledger: concurrent job attribution, retry billing, cached tokens, interrupted requests, CAPTCHA passed.');
} finally { globalThis.fetch = originalFetch; }
