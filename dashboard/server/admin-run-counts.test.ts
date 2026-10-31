import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { preparedEventsCountSql, preparedRunCount } from './admin-run-counts.js';

test('history counts only prepared events for the run owner and time, regardless of later draft status', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE run_starts(id INTEGER, user_id INTEGER, started_at INTEGER, finished_at INTEGER);
      CREATE TABLE run_events(user_id INTEGER, status TEXT, ts INTEGER);
      INSERT INTO run_starts VALUES (1, 183, 100, 200), (2, 183, 201, 300), (3, 184, 100, 200);
      INSERT INTO run_events VALUES (183, 'prepared', 150), (183, 'applied', 160),
        (183, 'prepared', 250), (184, 'prepared', 155), (183, 'prepared', 99);`);
    const rows = db.prepare(`SELECT r.id, ${preparedEventsCountSql} AS prepared FROM run_starts r ORDER BY r.id`).all();
    assert.deepEqual(rows.map(row => Number(row.prepared)), [1, 1, 1]);
  } finally { db.close(); }
});

test('the active run shows its unsynced count without assigning it to an older run', () => {
  assert.equal(preparedRunCount('0', '1057', '1057', 2), 2);
  assert.equal(preparedRunCount('1', '1049', '1057', 2), 1);
  assert.equal(preparedRunCount('0', '1057', null, 0), 0);
});
