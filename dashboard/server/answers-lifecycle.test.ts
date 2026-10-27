import assert from 'node:assert/strict';
import { getPool, query } from './db/index.js';
import { saveAnswers } from './answers.js';
import { loadAttention } from './attention.js';

const pool = getPool(); pool.options.max = 1;
try {
  await query(`CREATE TEMP TABLE saved_answers(user_id BIGINT, question TEXT, answer TEXT, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id,question))`);
  await query(`CREATE TEMP TABLE run_events(id BIGSERIAL, user_id BIGINT, job_id TEXT, status TEXT, title TEXT, company TEXT,
    reason TEXT, url TEXT, ts TIMESTAMPTZ DEFAULT now(), questions JSONB, dismissed_at TIMESTAMPTZ)`);
  await query(`CREATE TEMP TABLE applications(user_id BIGINT, job_id TEXT)`);
  const questions = JSON.stringify([{ question: 'Weekend availability?', prompt: 'Which weekends are available?' }]);
  // Save before the worker flushes its old needs-human event to Postgres.
  assert.equal((await saveAnswers('1', [{ question: 'Weekend availability?', answer: 'Saturday and Sunday' }], 'fixture-job')).saved, 1);
  await query(`INSERT INTO run_events(user_id,job_id,status,title,company,reason,ts,questions)
    VALUES (1,'fixture-job','needs-human','Fixture job','Fixture employer','Weekend answer needed',now()-interval '10 minutes',$1),
    (2,'fixture-job','needs-human','Other owner job','Fixture employer','Weekend answer needed',now()-interval '10 minutes',$1)`, [questions]);
  assert.equal((await loadAttention('1')).length, 0, 'late imports cannot resurrect an answered question');
  assert.equal((await loadAttention('2')).length, 1, 'another owner remains unaffected');
  assert.equal((await query('SELECT * FROM run_events WHERE user_id=1')).length, 2, 'old event and answer lifecycle are both preserved');
  await query(`INSERT INTO run_events(user_id,job_id,status,title,company,reason,ts,questions)
    VALUES (1,'fixture-job','needs-human','Fixture job','Fixture employer','A new required fact is needed',now()+interval '1 second',$1)`, [JSON.stringify([{ question: 'A different required question?' }])]);
  const fresh = await loadAttention('1');
  assert.equal(fresh.length, 1); assert.equal(fresh[0].questions?.[0].question, 'A different required question?');
  console.log('PASS: answers saved before delayed imports stay resolved; future questions and other owners remain visible. Temporary PostgreSQL tables only.');
} finally { await pool.end(); }
