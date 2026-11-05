import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPool, query } from './db/index.js';
import { assignApplicationModel, assignedApplicationModel, ApplicationModelAssignmentError } from './application-model-assignments.js';
import { accountApplicationEnvironment } from './runner.js';

// One connection, temporary tables only. No customer rows or provider calls.
const pool = getPool(); pool.options.max = 1;
const keys = ['ADMIN_EMAILS','CELERIS_API_KEY','OPENROUTER_API_KEY'] as const;
const old = Object.fromEntries(keys.map(key => [key,process.env[key]]));
Object.assign(process.env,{ADMIN_EMAILS:'admin@fixture.invalid',CELERIS_API_KEY:'fixture-celeris',OPENROUTER_API_KEY:'fixture-minimax'});
try {
  await query('CREATE TEMP TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ)');
  await query("INSERT INTO users VALUES(1,'admin@fixture.invalid',NULL),(2,'candidate@fixture.invalid',NULL),(3,'other@fixture.invalid',NULL),(4,'admin@fixture.invalid',now()),(99,'rollback@fixture.invalid',NULL)");
  const ddl = readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8').match(/CREATE TABLE IF NOT EXISTS application_model_assignments \([\s\S]*?\n\);/)![0];
  await query(ddl.replace('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE'));
  assert.equal(await assignedApplicationModel('2'),null);
  for (const actor of ['2','4','999']) await assert.rejects(assignApplicationModel(actor,'2','minimax'), error => error instanceof ApplicationModelAssignmentError && error.status === 403);
  await assert.rejects(assignApplicationModel('1','999','minimax'), error => error instanceof ApplicationModelAssignmentError && error.status === 404);
  for (const model of ['retired',null,{},['minimax']]) await assert.rejects(assignApplicationModel('1','2',model),ApplicationModelAssignmentError);
  assert.equal((await query('SELECT * FROM application_model_assignments')).length,0);

  await assignApplicationModel('1','2','minimax');
  await assignApplicationModel('1','2','minimax');
  assert.equal((await query('SELECT * FROM application_model_assignments')).length,1,'repeated saves retain one audit entry');
  assert.equal(await assignedApplicationModel('3'),null,'another account remains on its default');
  for (const start of ['manual-run','scheduled-run','admin-run']) {
    const env = await accountApplicationEnvironment('2',{APPLICATION_AI_MODEL:'celeris',ADMIN_ASSIGNED_MODEL:'celeris'},start);
    assert.equal(env.APPLICATION_AI_MODEL,'minimax',`${start} rechecks the persistent admin choice`);
    assert.equal(env.OPENROUTER_API_KEY,'fixture-minimax'); assert.equal(env.CELERIS_API_KEY,'');
  }
  const alreadyRunning = await accountApplicationEnvironment('2',{});
  await assignApplicationModel('1','2','celeris');
  const laterRun = await accountApplicationEnvironment('2',{APPLICATION_AI_MODEL:'minimax'});
  assert.equal(laterRun.APPLICATION_AI_MODEL,'celeris'); assert.equal(laterRun.CELERIS_API_KEY,'fixture-celeris'); assert.equal(laterRun.OPENROUTER_API_KEY,'');
  assert.equal(alreadyRunning.APPLICATION_AI_MODEL,'minimax','changing the choice does not mutate a running environment');
  const audit=await query('SELECT model,assigned_by::text FROM application_model_assignments WHERE user_id=2 ORDER BY id');
  assert.deepEqual(audit,[{model:'minimax',assigned_by:'1'},{model:'celeris',assigned_by:'1'}]);
  await assignApplicationModel('1','2','minimax');
  process.env.OPENROUTER_API_KEY='';
  await assert.rejects(accountApplicationEnvironment('2',{}),/OPENROUTER_API_KEY/,'missing MiniMax configuration cannot fall back to Celeris');
  assert.equal(await assignedApplicationModel('2'),'minimax');
  await query('ALTER TABLE application_model_assignments ADD CONSTRAINT fixture_failure CHECK(user_id<>99)');
  await assert.rejects(assignApplicationModel('1','99','minimax'),/check constraint/);
  assert.equal(await assignedApplicationModel('99'),null,'failed saves roll back');
  console.log('PASS: persistent admin model choice, audit/idempotency, blocked/non-admin denial, owner isolation, manual/scheduled/admin worker resolution, immutable running environment, selected-key isolation, missing-provider refusal and rollback; temporary PostgreSQL only.');
} finally {
  for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key]=old[key];
  await pool.end();
}
