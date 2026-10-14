import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { summariseApplicationCosts, formatApplicationCost, type UsageEvent } from '../src/application-cost.js';
import { parseCostEvent } from './application-costs.js';
const runId = randomUUID();
const event = (e: Partial<UsageEvent>): UsageEvent => ({ id: randomUUID(), runId, at: new Date().toISOString(), kind: 'usage', provider: 'Celeris', amountUsd: 0, basis: 'estimated', ...e });
const rows = [event({ jobId: 'a', amountUsd: 1 }), event({ jobId: 'b', amountUsd: 2 }),
  event({ jobId: 'failed', amountUsd: 3 }), event({ amountUsd: 4 }),
  event({ kind: 'submitted', jobId: 'a' }), event({ kind: 'submitted', jobId: 'b' }), event({ kind: 'finished' })];
let result = summariseApplicationCosts([...rows, ...rows]);
assert.equal(result.a.totalUsd, 4.5); assert.equal(result.b.totalUsd, 5.5);
assert.equal(result.failed, undefined);
assert.equal(result.a.totalUsd + result.b.totalUsd, 10, 'allocation conserves spend; re-sync does not double bill');
assert.equal(result.a.incomplete, false);
result = summariseApplicationCosts([...rows, event({ jobId: 'a', amountUsd: null, provider: 'Bright Data' })]);
assert.equal(result.a.totalUsd, 4.5); assert.equal(result.a.incomplete, true);
assert.equal(formatApplicationCost(result.a), 'US$4.5000 +');
assert.equal(formatApplicationCost(undefined), 'Not recorded');
assert.equal(formatApplicationCost(summariseApplicationCosts([event({ jobId: 'a', amountUsd: null })]).a), 'Unavailable');
assert.equal(summariseApplicationCosts(rows.filter(e => e.kind !== 'finished')).a.incomplete, true);
const retryRun = randomUUID();
result = summariseApplicationCosts([...rows, event({ runId: retryRun, jobId: 'a', amountUsd: 6 }), event({ runId: retryRun, amountUsd: 1 }), event({ runId: retryRun, kind: 'finished' })]);
assert.equal(result.a.totalUsd, 11.5, 'earlier failed attempts add to this job');
assert.equal(result.b.totalUsd, 5.5);
assert.ok(parseCostEvent(JSON.stringify(rows[0])));
assert.equal(parseCostEvent('{partial'), null);
assert.equal(parseCostEvent(JSON.stringify({ ...rows[0], amountUsd: -3 })), null);
assert.equal(parseCostEvent(JSON.stringify({ ...rows[0], jobId: {} })), null);
console.log('Application costs: shared allocation, conservation, retries, idempotency, unknown/legacy costs, interrupted runs and malformed journal records passed.');
