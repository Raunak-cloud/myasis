import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPool, query } from './db/index.js';
import { markApplicationUnconfirmed } from './db/records.js';

// One connection keeps temporary fixture tables isolated from production data.
const pool = getPool(); pool.options.max = 1;
try {
  await query(`CREATE TEMP TABLE applications(user_id BIGINT, platform TEXT, job_id TEXT, title TEXT, company TEXT,
    url TEXT, submitted_by_myasis BOOLEAN, cover_letter TEXT, applied_at TEXT)`);
  await query(`CREATE TEMP TABLE run_events(id BIGSERIAL, user_id BIGINT, job_id TEXT, status TEXT, title TEXT, company TEXT, reason TEXT, url TEXT)`);
  const schema = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
  const migration = schema.match(/ALTER TABLE applications ADD COLUMN IF NOT EXISTS confirmation_status[^;]+;/)![0];
  await query(migration); await query(migration);
  await query(`INSERT INTO applications VALUES (2,'seek','mimco','Mimco','Fixture','https://fixture.invalid',true,'Original letter','original time',NULL),
    (3,'seek','mimco','Other owner','Fixture','https://fixture.invalid',true,'Other letter','other time',NULL),
    (2,'indeed','mimco','Other board','Fixture','https://fixture.invalid',true,'Other board letter','other time',NULL)`);
  assert.equal(await markApplicationUnconfirmed('2', 'seek', 'mimco', 'Corrected applied to unconfirmed: no employer receipt.'), true);
  assert.equal(await markApplicationUnconfirmed('2', 'seek', 'mimco', 'Repeated operator request.'), false);
  const rows = await query('SELECT * FROM applications ORDER BY user_id, platform DESC');
  const corrected = rows.find(r => r.user_id === '2' && r.platform === 'seek')!;
  assert.equal(corrected.confirmation_status, 'unconfirmed');
  assert.equal(corrected.submitted_by_myasis, false);
  assert.equal(corrected.cover_letter, 'Original letter'); assert.equal(corrected.applied_at, 'original time');
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(r => r.submitted_by_myasis).length, 2, 'other owner and platform are unchanged');
  assert.equal((await query('SELECT * FROM run_events')).length, 1, 'correction appends exactly one audit event');
  console.log('PASS: owner/platform-scoped unconfirmed correction, preserved history, excluded submitted count and idempotent audit; temporary PostgreSQL tables only.');
} finally { await pool.end(); }
