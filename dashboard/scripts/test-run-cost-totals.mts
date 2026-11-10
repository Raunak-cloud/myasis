import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool } from '../server/db/index.js';
import { ADMIN_RUN_COST_SQL, aggregateRunCosts, costRunEnd, type CostRun, type OwnerCostEvent } from '../server/admin-run-costs.js';

const connection = await getPool().connect();
const base: CostRun = { id: '10', userId: '183', startedAt: '2026-11-01T01:00:00.000Z', finishedAt: '2026-11-01T02:00:00.000Z', nextStartedAt: null, running: false };
const worker = randomUUID();
const event = (kind: 'started' | 'usage' | 'finished', extra: Record<string, unknown> = {}): OwnerCostEvent => ({ userId: '183',
  event: { id: randomUUID(), runId: worker, at: '2026-11-01T01:05:00.000Z', kind, ...extra } });
const later = { ...base, id: '11', startedAt: base.finishedAt!, finishedAt: '2026-11-01T03:00:00.000Z' };
const started = event('started'), charge = event('usage', { amountUsd: 2, basis: 'estimated' }), finished = event('finished');
const cases = [
  { runs: [base], events: [started, charge, finished], live: [] },
  { runs: [base], events: [started, charge], live: [finished] },
  { runs: [base], events: [started, charge, finished], live: [{ ...charge, event: { ...charge.event, amountUsd: 3 } }] },
  { runs: [base], events: [started, event('usage', { amountUsd: null }), finished], live: [] },
  { runs: [base], events: [started, event('usage', { amountUsd: 0, basis: 'unknown' }), finished], live: [] },
  { runs: [base, { ...base, id: '12' }], events: [started, charge, finished], live: [] },
  { runs: [{ ...base, finishedAt: null, running: false, nextStartedAt: later.startedAt }, later], events: [started, charge, finished,
    event('started', { runId: 'other', at: later.startedAt }), event('usage', { runId: 'other', amountUsd: 5 }), event('finished', { runId: 'other' })], live: [] },
  { runs: [base, later], events: [event('started', { runStartId: '10' }), event('usage', { runStartId: '10', at: later.startedAt, amountUsd: 7 }),
    event('finished', { runStartId: '10' }), event('usage', { amountUsd: 999 })], live: [] },
  { runs: [base], events: [event('usage', { runStartId: '10', amountUsd: 1 }), event('finished', { runStartId: '10' }),
    { ...event('usage', { runStartId: '10', amountUsd: 999 }), userId: '1' }], live: [] },
  { runs: [base], events: [], live: [started, charge, finished] },
  { runs: [base], events: [event('started', { at: base.finishedAt }), charge, finished], live: [] },
];
try {
  await connection.query('BEGIN');
  // A connection-private temporary table shadows the ledger for this query.
  // Production records are never updated or truncated.
  await connection.query('CREATE TEMP TABLE application_cost_events(user_id bigint,event_id text,run_id text,payload jsonb) ON COMMIT DROP');
  for (const fixture of cases) {
    await connection.query('TRUNCATE pg_temp.application_cost_events');
    for (const record of fixture.events) await connection.query('INSERT INTO pg_temp.application_cost_events VALUES($1,$2,$3,$4::jsonb)',
      [record.userId, record.event.id, record.event.runId, JSON.stringify(record.event)]);
    const windows = fixture.runs.map(run => ({ id: run.id, user_id: run.userId, started_at: run.startedAt,
      end_at: Number.isFinite(costRunEnd(run)) ? new Date(costRunEnd(run)).toISOString() : null }));
    const result = await connection.query(ADMIN_RUN_COST_SQL, [JSON.stringify(windows), JSON.stringify(fixture.live.map(r => ({ user_id: r.userId, event: r.event })))]);
    const expected = aggregateRunCosts(fixture.runs, [...fixture.events, ...fixture.live], []);
    for (const run of fixture.runs) {
      const old = expected.get(run.id), row = result.rows.find(row => row.id === run.id);
      if (!old) assert.equal(row, undefined);
      else {
        assert.ok(row); assert.ok(Math.abs(Number(row.total) - old.totalUsd) < 1e-9);
        assert.equal(row.known, old.knownCharges);
        assert.equal(run.running || !run.finishedAt || Boolean(row.incomplete), old.incomplete);
        assert.equal(Boolean(row.estimated), old.estimated);
      }
    }
  }
  console.log(`PASS: ${cases.length} database cost fixtures preserve totals, live deduplication, owner isolation, explicit IDs, ambiguous legacy starts and incomplete costs.`);
} finally { await connection.query('ROLLBACK'); connection.release(); await getPool().end(); }
