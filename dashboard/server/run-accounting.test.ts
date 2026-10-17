import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { countedRunSql } from './run-accounting.js';

// Execute the shared SQL policy against run records, without touching live data.
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE run_starts (
  id INTEGER, user_id INTEGER, trigger TEXT, mode TEXT, started_at INTEGER,
  finished_at INTEGER, successful INTEGER, applied INTEGER, stopped INTEGER
)`);
const insert = db.prepare('INSERT INTO run_starts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const rows = [
  [1, 1, 'auto', 'live', 100, 101, 0, 0, 0], // empty failure, before productive timeout
  [2, 1, 'auto', 'live', 110, 111, 0, 11, 0], // actual regression: 11 sent before timeout
  [3, 1, 'auto', 'live', 120, 121, 0, 1, 1], // Stop after a confirmed submission
  [4, 1, 'auto', 'live', 130, 131, 0, 0, 0], // subsequent empty failure
  [5, 1, 'auto', 'live', 140, 141, 0, 0, 1], // empty Stop stays retryable
  [6, 2, 'auto', 'live', 150, 151, 1, 0, 0], // normal complete search without matches
  [7, 2, 'manual', 'live', 160, 161, 1, 2, 0], // manual runs do not spend automatic slots
  [8, 2, 'auto', 'live', 170, null, 0, 3, 0], // running: not counted until durable completion
  [9, 2, 'auto', 'live', 50, 51, 1, 2, 0], // previous day
  [10, 3, 'onboarding', 'live', 180, 181, 1, 1, 0],
  [11, 3, 'auto', 'scan', 190, 191, 0, 2, 0], // failed scans do not submit applications
];
try {
  for (const row of rows) insert.run(...row);
  const count = db.prepare(`SELECT count(*) AS n FROM run_starts r
    WHERE r.user_id = ? AND r.trigger IN ('auto', 'onboarding')
      AND ${countedRunSql('r')} AND r.started_at >= 100`);
  assert.equal(count.get(1)?.n, 2);
  assert.equal(count.get(2)?.n, 1);
  assert.equal(count.get(3)?.n, 1);
  const failures = db.prepare(`SELECT r.id FROM run_starts r
    WHERE r.user_id = 1 AND r.trigger IN ('auto', 'onboarding')
      AND r.finished_at IS NOT NULL AND NOT ${countedRunSql('r')} AND NOT r.stopped
      AND r.started_at > COALESCE((SELECT max(s.started_at) FROM run_starts s
        WHERE s.user_id = r.user_id AND ${countedRunSql('s')}), 0)`);
  assert.deepEqual(failures.all().map(row => row.id), [4], 'productive timeouts reset retry backoff');
  assert.equal(db.prepare('SELECT successful FROM run_starts WHERE id = 2').get()?.successful, 0,
    'counting work must not rewrite a timeout as a healthy completion');
} finally {
  db.close();
}
console.log('PASS: productive timeouts/Stop count once; empty failures retry; owners, days, manual runs and running attempts stay separate');
