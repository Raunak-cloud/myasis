/** Temporary PostgreSQL tables and fictional accounts only. No candidate writes. */
import assert from 'node:assert/strict';
import {getPool,query} from './db/index.js';
import {insertRunEventRow} from './db/records.js';
import {loadAttention,candidateAttention,dismissAllAttention} from './attention.js';
import {accountAccessMessage} from '../../seek-bot/src/employer-account.js';
const pool=getPool();pool.options.max=1;
try{
 await query(`CREATE TEMP TABLE run_events(id BIGSERIAL,user_id BIGINT,job_id TEXT,status TEXT,title TEXT,company TEXT,reason TEXT,url TEXT,ts TIMESTAMPTZ,questions JSONB,account_access JSONB,dismissed_at TIMESTAMPTZ,review_disposition TEXT,review_listing_fingerprint TEXT,review_context_fingerprint TEXT,review_expires_at TIMESTAMPTZ,review_content_fingerprint TEXT,UNIQUE(user_id,job_id,status,ts)); CREATE TEMP TABLE applications(user_id BIGINT,job_id TEXT)`);
 const task={jobId:'fictional-account',status:'needs-human',title:'Synthetic analyst',company:'Fixture Employer',reason:'INTERNAL_DIAGNOSTIC_MUST_NOT_LEAK',url:'https://employer.fixture.invalid/login',ts:new Date(Date.now()-60000),accountAccess:{version:1,kind:'existing-account',site:'employer.fixture.invalid/?owtomate_employer=fixture%20employer'}};
 await insertRunEventRow('1',task);await insertRunEventRow('1',task);await insertRunEventRow('2',task);
 assert.equal((await query('SELECT * FROM run_events WHERE user_id=1')).length,1,'reimport does not duplicate account tasks');
 let visible=candidateAttention(await loadAttention('1'));
 assert.equal(visible.length,1);assert.equal(visible[0].kind,'account-access');assert.equal(visible[0].reason,accountAccessMessage);assert.deepEqual(visible[0].questions,[]);assert.doesNotMatch(JSON.stringify(visible),/INTERNAL_DIAGNOSTIC/);
 await insertRunEventRow('1',{jobId:task.jobId,status:'answered',ts:new Date(Date.now()-30000)});
 assert.equal((await loadAttention('1')).length,1,'answering a screening question cannot resolve employer sign-in');
 await insertRunEventRow('1',{jobId:task.jobId,status:'prepared',ts:new Date()});
 assert.equal((await loadAttention('1')).length,0,'successful preparation resolves the access task');
 assert.equal((await loadAttention('2')).length,1,'another owner is unaffected');
 await dismissAllAttention('2');assert.equal((await loadAttention('2')).length,0);
 assert.equal((await query('SELECT * FROM run_events WHERE user_id=2')).length,1,'dismissal preserves audit history');
 console.log('PASS: employer-access outcomes survive database import, deduplicate, isolate owners, hide diagnostics and resolve only through completion or explicit dismissal.');
}finally{await pool.end();}
