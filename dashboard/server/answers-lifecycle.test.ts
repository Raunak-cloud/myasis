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
  const address = { question: 'Address Line 1', prompt: 'What is your street address?' };
  const birth = { question: 'Date of Birth', prompt: 'What is your full date of birth?', kind: 'text' };
  await query(`INSERT INTO run_events(user_id,job_id,status,title,company,reason,url,ts,questions)
    VALUES (1,'partial-job','needs-human','Partial fixture','Fixture employer','Required personal details','https://example.test/job',now()-interval '5 minutes',$1),
    (2,'partial-job','needs-human','Other owner fixture','Fixture employer','Required personal details','https://example.test/job',now()-interval '5 minutes',$1)`, [JSON.stringify([address, birth])]);
  await saveAnswers('1', [{ ...address, answer: '123 Fixture Street' }], 'partial-job');
  const partial = (await loadAttention('1')).find(item => item.jobId === 'partial-job');
  assert.deepEqual(partial?.questions, [birth], 'saving an address must retain the unanswered date of birth');
  assert.equal(partial?.title, 'Partial fixture');
  assert.equal(partial?.url, 'https://example.test/job');
  assert.equal((await query(`SELECT * FROM run_events WHERE user_id=1 AND job_id='partial-job' AND dismissed_at IS NOT NULL`)).length, 0, 'a partial answer preserves the original audit event');
  assert.equal((await loadAttention('2')).find(item => item.jobId === 'partial-job')?.questions?.length, 2, 'partial saves stay owner scoped');
  await saveAnswers('1', [{ ...birth, answer: '01 January 1990' }], 'partial-job');
  assert.equal((await loadAttention('1')).some(item => item.jobId === 'partial-job'), false, 'the last answer resolves the group');

  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions)
    VALUES (1,'prompt-context','needs-human','Context fixture',$1)`, [JSON.stringify([{ question: 'Tell us more', prompt: 'What is your notice period?' }])]);
  await saveAnswers('1', [{ question: 'Tell us more', prompt: 'Why do you want this role?', answer: 'A relevant role' }], 'prompt-context');
  assert.equal((await loadAttention('1')).find(item => item.jobId === 'prompt-context')?.questions?.[0]?.prompt, 'What is your notice period?', 'a matching short label cannot clear a different full question');

  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions)
    VALUES (1,'rollback-fixture','needs-human','Rollback fixture',$1)`, [JSON.stringify([{ question: 'Rollback question' }])]);
  await query(`ALTER TABLE run_events ADD CONSTRAINT reject_rollback_fixture CHECK(job_id <> 'rollback-fixture') NOT VALID`);
  await assert.rejects(saveAnswers('1', [{ question: 'Rollback question', answer: 'Fixture answer' }], 'rollback-fixture'));
  assert.equal((await query(`SELECT * FROM saved_answers WHERE user_id=1 AND question='Rollback question'`)).length, 0, 'a failed lifecycle update must roll back the answer');
  assert.equal((await query(`SELECT * FROM run_events WHERE user_id=1 AND job_id='rollback-fixture' AND dismissed_at IS NULL`)).length, 1, 'a failed save must preserve the original question');
  console.log('PASS: partial answers retain remaining questions; final answers resolve; prompt context, owner isolation, atomic failure and delayed imports verified. Temporary PostgreSQL tables only.');
} finally { await pool.end(); }
