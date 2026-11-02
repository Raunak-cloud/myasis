import assert from 'node:assert/strict';
import { getPool, query } from './db/index.js';
import { saveAnswers } from './answers.js';
import { dismissAllAttention, loadAttention } from './attention.js';
import { loadAnswerStateForRun } from './db/run-sync.js';
import { sealQuestionSnapshot } from '../../seek-bot/src/question-snapshot-node.js';
import { blockedQuestionKey } from '../../seek-bot/src/blocked-question-key.js';
import { AnswersValidationError, listAnswers } from './answers.js';
import pg from 'pg';
import { insertRunEventRow } from './db/records.js';

const pool = getPool(); pool.options.max = 1;
try {
  await query(`CREATE TEMP TABLE saved_answers(user_id BIGINT, question TEXT, answer TEXT, question_schema JSONB, answer_value JSONB, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id,question))`);
  await query(`CREATE TEMP TABLE run_events(id BIGSERIAL, user_id BIGINT, job_id TEXT, status TEXT, title TEXT, company TEXT,
    reason TEXT, url TEXT, ts TIMESTAMPTZ DEFAULT now(), questions JSONB, dismissed_at TIMESTAMPTZ,
    review_disposition TEXT, review_listing_fingerprint TEXT, review_context_fingerprint TEXT,
    review_expires_at TIMESTAMPTZ, review_content_fingerprint TEXT, UNIQUE(user_id,job_id,status,ts))`);
  await query(`CREATE TEMP TABLE applications(user_id BIGINT, job_id TEXT)`);
  const questions = JSON.stringify([{ question: 'Weekend availability?', prompt: 'Which weekends are available?' }]);
  // Save before the worker flushes its old needs-human event to Postgres.
  assert.equal((await saveAnswers('1', [{ question: 'Weekend availability?', prompt: 'Which weekends are available?', answer: 'Saturday and Sunday' }], 'fixture-job')).saved, 1);
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
  await saveAnswers('1', [{ ...address, answer: '123 Fixture Street' }], 'delayed-partial');
  await query(`INSERT INTO run_events(user_id,job_id,status,title,ts,questions)
    VALUES (1,'delayed-partial','needs-human','Delayed partial fixture',now()-interval '5 minutes',$1)`, [JSON.stringify([address, birth])]);
  assert.deepEqual((await loadAttention('1')).find(item => item.jobId === 'delayed-partial')?.questions, [birth], 'a partial answer before import must not clear an unimported required fact');
  await query(`INSERT INTO run_events(user_id,job_id,status,title,company,reason,ts,questions)
    VALUES (1,'delayed-newer-group','needs-human','Delayed newer fixture','Fixture employer','Original missing facts',now()-interval '5 minutes',$1)`, [JSON.stringify([address, birth])]);
  await saveAnswers('1', [{ ...address, answer: '123 Fixture Street' }], 'delayed-newer-group');
  const unknown = { question: 'Required licence number?' };
  await query(`INSERT INTO run_events(user_id,job_id,status,title,company,reason,ts,questions)
    VALUES (1,'delayed-newer-group','needs-human','Delayed newer fixture','Fixture employer','Additional required fact discovered',now()-interval '1 minute',$1)`, [JSON.stringify([address, birth, unknown])]);
  assert.deepEqual((await loadAttention('1')).find(item => item.jobId === 'delayed-newer-group')?.questions, [birth, unknown], 'a partial save cannot overwrite a newer required group imported later');
  const exported = await loadAnswerStateForRun('1');
  assert.deepEqual(exported.attention, await loadAttention('1'), 'the worker snapshot exposes exactly the remaining questions shown in Needs attention');
  assert.ok(exported.answers.some(item => item.question === address.prompt && item.answer === '123 Fixture Street'));
  assert.ok(Number.isFinite(Date.parse(exported.asOf)));
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
  const marked = { question: 'Current clearance', prompt: 'Current clearance *' };
  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions)
    VALUES (1,'required-marker','needs-human','Required marker fixture',$1)`, [JSON.stringify([marked])]);
  await saveAnswers('1', [{ ...marked, answer: 'None' }], 'required-marker');
  assert.equal((await loadAttention('1')).some(item => item.jobId === 'required-marker'), false, 'a required marker in the source-only prompt cannot prevent the saved answer from resolving it');

  await query(`WITH stamp AS (SELECT date_trunc('milliseconds', clock_timestamp()) - interval '2 minutes' AS ts)
    INSERT INTO run_events(user_id,job_id,status,title,company,reason,ts,questions)
      SELECT 1,'microsecond-order','answered','Precision fixture','Fixture employer','Answer saved',ts + interval '800 microseconds',$1::jsonb FROM stamp
      UNION ALL
      SELECT 1,'microsecond-order','needs-human','Precision fixture','Fixture employer','Older delayed blocker',ts + interval '100 microseconds',$1::jsonb FROM stamp`, [JSON.stringify([{ question: 'Precision question?' }])]);
  assert.equal((await loadAttention('1')).some(item => item.jobId === 'microsecond-order'), false, 'a delayed older blocker in the same millisecond cannot sort after the newer answer');

  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions)
    VALUES (1,'prompt-context','needs-human','Context fixture',$1)`, [JSON.stringify([{ question: 'Tell us more', prompt: 'What is your notice period?' }])]);
  await saveAnswers('1', [{ question: 'Tell us more', prompt: 'Why do you want this role?', answer: 'A relevant role' }], 'prompt-context');
  assert.equal((await loadAttention('1')).find(item => item.jobId === 'prompt-context')?.questions?.[0]?.prompt, 'What is your notice period?', 'a matching short label cannot clear a different full question');
  await saveAnswers('1', [{ question: 'Tell us more', answer: 'Two weeks' }], 'prompt-context');
  assert.equal((await loadAttention('1')).find(item => item.jobId === 'prompt-context')?.questions?.[0]?.prompt, 'What is your notice period?', 'a stale legacy label without context cannot clear a prompted question');

  for (const invalid of [[null], [{ question: 'Password' }], [{ question: {} }]]) {
    await query(`INSERT INTO run_events(user_id,job_id,status,title,questions) VALUES (1,'prompt-context','needs-human','Invalid later blocker',$1)`, [JSON.stringify(invalid)]);
    assert.equal((await loadAttention('1')).find(item => item.jobId === 'prompt-context')?.questions?.[0]?.prompt, 'What is your notice period?', 'normalisation must happen before choosing the latest actionable group');
  }

  await dismissAllAttention('1');
  await query(`INSERT INTO run_events(user_id,job_id,status,title,ts,questions)
    VALUES (1,'prompt-context','needs-human','Delayed dismissed import',now()-interval '1 minute',$1)`, [JSON.stringify([address])]);
  assert.equal((await loadAttention('1')).some(item => item.jobId === 'prompt-context'), false, 'a delayed import predating dismissal cannot resurrect the group');
  assert.equal((await loadAttention('2')).length, 2, 'dismissal cannot affect another account');
  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions) VALUES (1,'prompt-context','needs-human','Fresh after dismissal',$1)`, [JSON.stringify([birth])]);
  assert.deepEqual((await loadAttention('1')).find(item => item.jobId === 'prompt-context')?.questions, [birth], 'a genuinely fresh required question can recur after dismissal');

  const snapshot=sealQuestionSnapshot({version:2,source:{origin:'https://employer.example',path:'/apply'},prompt:'Which regions can you work in?',context:['Current preferences'],help:[],completeness:'complete',controls:[{id:'part0',label:'Regions',kind:'checkbox-group',multiple:true,required:true,choices:[{id:'choice0',label:'Sydney',value:'SYD',disabled:false},{id:'choice1',label:'Melbourne',value:'MEL',disabled:false}],constraints:{}}]});
  const blocked={question:snapshot.prompt,snapshot};
  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions) VALUES(1,'typed-fixture','needs-human','Typed fixture',$1)`,[JSON.stringify([blocked])]);
  const payload={questionId:snapshot.id,revision:snapshot.revision,response:{part0:['choice0','choice1']}};
  await assert.rejects(saveAnswers('2',[payload],'typed-fixture'),AnswersValidationError,'a foreign owner cannot use another owner question identity');
  await assert.rejects(saveAnswers('1',[{...payload,revision:'0'.repeat(64)}],'typed-fixture'),AnswersValidationError,'stale revisions fail before saving');
  await assert.rejects(saveAnswers('1',[{...payload,response:{part0:['Invented option']}}],'typed-fixture'),AnswersValidationError);
  await assert.rejects(saveAnswers('1',[{question:snapshot.prompt,answer:'Sydney'}],'typed-fixture'),AnswersValidationError,'legacy clients cannot erase a typed current task');
  await assert.rejects(saveAnswers('1',[{question:blockedQuestionKey(blocked),answer:'Invented answer'}],'typed-fixture'),AnswersValidationError,'legacy clients cannot forge the reserved structured storage key');
  assert.equal((await saveAnswers('1',[payload,{...payload,response:{part0:['choice1','choice0']}}],'typed-fixture')).saved,1,'duplicate submissions of the same choice set are idempotent regardless of click order');
  assert.equal((await loadAttention('1')).some(item=>item.jobId==='typed-fixture'),false);
  const stored=(await listAnswers('1')).find(a=>a.snapshot?.id===snapshot.id)!;
  assert.deepEqual(stored.snapshot,snapshot);assert.deepEqual(stored.response,payload.response);
  assert.equal(stored.answer,'Sydney; Melbourne');
  assert.equal(stored.storageKey,blockedQuestionKey(blocked));
  const typedExport=await loadAnswerStateForRun('1');
  assert.deepEqual(typedExport.answers.find(a=>a.snapshot?.id===snapshot.id)?.response,payload.response,'run export preserves the complete typed answer');
  const countBeforeReplay=(await query(`SELECT id FROM run_events WHERE user_id=1 AND job_id='typed-fixture' AND status='answered'`)).length;
  assert.equal((await saveAnswers('1',[payload],'typed-fixture')).saved,1,'a lost successful response can be acknowledged idempotently');
  assert.equal((await query(`SELECT id FROM run_events WHERE user_id=1 AND job_id='typed-fixture' AND status='answered'`)).length,countBeforeReplay,'an exact replay writes no extra fact or lifecycle event');
  await assert.rejects(saveAnswers('1',[{...payload,response:{part0:['choice0']}}],'typed-fixture'),AnswersValidationError,'an old resolved form cannot change the committed answer');
  const newer=sealQuestionSnapshot({...snapshot,controls:[{...snapshot.controls[0],choices:[...snapshot.controls[0].choices,{id:'choice2',label:'Perth',value:'PER',disabled:false}]}]});
  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions) VALUES(1,'typed-fixture','needs-human','Updated original options',$1)`,[JSON.stringify([{question:newer.prompt,snapshot:newer}])]);
  assert.equal((await loadAttention('1')).find(item=>item.jobId==='typed-fixture')?.questions?.[0].snapshot?.revision,newer.revision,'changed options are a new question revision, not silently resolved by an old answer');
  await assert.rejects(saveAnswers('1',[payload],'typed-fixture'),AnswersValidationError);
  const partialCapture=sealQuestionSnapshot({...newer,completeness:'recapture'});
  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions) VALUES(1,'partial-catalog','needs-human','Partial options',$1)`,[JSON.stringify([{question:partialCapture.prompt,snapshot:partialCapture}])]);
  await assert.rejects(saveAnswers('1',[{...payload,revision:partialCapture.revision}],'partial-catalog'),AnswersValidationError);

  const formatSnapshot=sealQuestionSnapshot({...snapshot,prompt:'Employer reference',controls:[{id:'part0',label:'Employer reference',kind:'text',required:false,multiple:false,choices:[],constraints:{pattern:'[0-9]{4}'}}]});
  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions) VALUES(1,'format-validation','needs-human','Format fixture',$1)`,[JSON.stringify([{question:formatSnapshot.prompt,snapshot:formatSnapshot}])]);
  const formatted={questionId:formatSnapshot.id,revision:formatSnapshot.revision,response:{part0:'abc'}};
  await assert.rejects(saveAnswers('1',[formatted],'format-validation'),AnswersValidationError,'the API checks employer patterns even if a client skips native validation');
  await assert.rejects(saveAnswers('1',[{...formatted,response:{part0:''}}],'format-validation'),AnswersValidationError,'missing HTML required markers never allow an empty fact to clear a task');
  assert.equal((await listAnswers('1')).some(a=>a.snapshot?.id===formatSnapshot.id),false,'failed format validation commits neither a fact nor a resolution');
  assert.ok((await loadAttention('1')).some(a=>a.jobId==='format-validation'));
  await saveAnswers('1',[{...formatted,response:{part0:'1234'}}],'format-validation');
  assert.equal((await loadAttention('1')).some(a=>a.jobId==='format-validation'),false);

  // A second database session represents an answer transaction holding the
  // owner/job lease. The real importer must wait; all rows are temporary.
  const blocker=new pg.Client({connectionString:pool.options.connectionString});
  await blocker.connect();
  let imported=false;
  let importing:Promise<void>|undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['candidate-answers:1:locked-import']);
    importing=insertRunEventRow('1',{jobId:'locked-import',status:'needs-human',questions:[blocked]}).then(()=>{imported=true;});
    await new Promise(done=>setTimeout(done,150));
    assert.equal(imported,false,'question import waits for the same owner/job answer lock');
    await blocker.query('COMMIT');
    await importing;
    assert.equal(imported,true);
    assert.equal((await loadAttention('1')).find(i=>i.jobId==='locked-import')?.questions?.[0].snapshot?.revision,snapshot.revision);
  }finally{await blocker.query('ROLLBACK');await blocker.end();await importing;}

  await query(`INSERT INTO run_events(user_id,job_id,status,title,questions)
    VALUES (1,'rollback-fixture','needs-human','Rollback fixture',$1)`, [JSON.stringify([{ question: 'Rollback question' }])]);
  await query(`ALTER TABLE run_events ADD CONSTRAINT reject_rollback_fixture CHECK(job_id <> 'rollback-fixture') NOT VALID`);
  await assert.rejects(saveAnswers('1', [{ question: 'Rollback question', answer: 'Fixture answer' }], 'rollback-fixture'));
  assert.equal((await query(`SELECT * FROM saved_answers WHERE user_id=1 AND question='Rollback question'`)).length, 0, 'a failed lifecycle update must roll back the answer');
  assert.equal((await query(`SELECT * FROM run_events WHERE user_id=1 AND job_id='rollback-fixture' AND dismissed_at IS NULL`)).length, 1, 'a failed save must preserve the original question');
  console.log('PASS: partial answers retain remaining questions; final answers resolve; prompt context, owner isolation, atomic failure and delayed imports verified. Temporary PostgreSQL tables only.');
} finally { await pool.end(); }
