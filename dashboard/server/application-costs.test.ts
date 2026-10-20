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
assert.equal(result.a.totalUsd, 4.5, 'attempts outside the confirmed submission run do not inflate its cost');
assert.equal(result.b.totalUsd, 5.5);
const retiredRun = randomUUID();
const retired = [
  event({ runId: retiredRun, at: '2026-10-20T10:00:00Z', jobId: 'a', provider: 'Anthropic', model: 'claude-haiku-5-5', amountUsd: 0.0097 }),
  event({ runId: retiredRun, at: '2026-10-20T10:00:01Z', provider: 'Anthropic', model: 'claude-haiku-5-5', amountUsd: null }),
];
result = summariseApplicationCosts([...retired, ...rows]);
assert.equal(result.a.totalUsd, 4.5);
assert.equal(result.a.incomplete, false, 'an old interrupted run cannot mark the current submission incomplete');
assert.doesNotMatch(JSON.stringify(result.a), /haiku|anthropic/i);
const mixed = [event({ jobId: 'a', provider: 'Anthropic', model: 'claude-haiku-5-5', amountUsd: 9 }),
  event({ jobId: 'a', provider: 'OpenRouter', model: 'anthropic/claude-haiku-5.5', amountUsd: null })];
result = summariseApplicationCosts([...rows, ...mixed]);
assert.equal(result.a.totalUsd, 4.5, 'hidden retired-provider spend is also excluded from the displayed total');
assert.equal(result.a.incomplete, true);
assert.equal(result.a.lines.reduce((sum, line) => sum + line.amountUsd, 0), result.a.totalUsd);
assert.ok(result.a.notes.some(note => note.includes('Retired-provider charges are excluded')));
assert.doesNotMatch(JSON.stringify(result.a), /haiku|anthropic/i);
result = summariseApplicationCosts([...mixed, event({ kind: 'finished' })]);
assert.equal(formatApplicationCost(result.a), 'Unavailable', 'excluded-only history is never displayed as zero cost');
assert.equal(result.a.lines.length, 0);
const latest = randomUUID();
const later = [event({ runId: latest, at: '2099-01-01T00:00:00Z', kind: 'submitted', jobId: 'a' }),
  event({ runId: latest, jobId: 'a', amountUsd: 2 }), event({ runId: latest, kind: 'finished' })];
for (const input of [[...rows, ...later], [...later, ...rows]]) {
  result = summariseApplicationCosts(input);
  assert.equal(result.a.totalUsd, 2, 'latest submission wins regardless of ledger merge order');
  assert.equal(result.b.totalUsd, 5.5, 'superseding another submission does not change shared allocation');
}
assert.ok(parseCostEvent(JSON.stringify(rows[0])));
assert.equal(parseCostEvent('{partial'), null);
assert.equal(parseCostEvent(JSON.stringify({ ...rows[0], amountUsd: -3 })), null);
assert.equal(parseCostEvent(JSON.stringify({ ...rows[0], jobId: {} })), null);
console.log('Application costs: submission-run scope, retired-provider exclusion, shared allocation, idempotency, unknown/legacy costs and malformed records passed.');
