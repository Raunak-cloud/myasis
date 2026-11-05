import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getPool,query} from './db/index.js';
import {recordApplicationOutcome,ApplicationOutcomeError} from './application-outcomes.js';

// One connection and temporary tables only; no production row is modified.
const pool=getPool();pool.options.max=1;
try{
 await query(`CREATE TEMP TABLE applications(id BIGSERIAL PRIMARY KEY,user_id BIGINT,platform TEXT,job_id TEXT,title TEXT,company TEXT,url TEXT,
  outcome TEXT,confirmation_status TEXT,submitted_by_myasis BOOLEAN,applied_at TEXT,cover_letter TEXT,score INTEGER DEFAULT 0)`);
 await query(`CREATE TEMP TABLE run_events(id BIGSERIAL,user_id BIGINT,job_id TEXT CHECK(job_id<>'rollback'),status TEXT,title TEXT,company TEXT,reason TEXT,url TEXT)`);
 await query(`INSERT INTO applications(user_id,platform,job_id,title,company,url,outcome,confirmation_status,submitted_by_myasis,applied_at,cover_letter) VALUES
  (2,'external','same','Dog walker','Fixture Dogs','https://fixture.invalid',NULL,'unconfirmed',false,'original timestamp','original letter'),
  (2,'indeed','same','Other board','Fixture','https://fixture.invalid/other',NULL,NULL,true,'other timestamp','other letter'),
  (3,'external','same','Other owner','Fixture','https://fixture.invalid/private',NULL,NULL,true,'private timestamp','private letter'),
  (2,'external','rollback','Rollback','Fixture','https://fixture.invalid/rollback',NULL,'unconfirmed',false,'original','original'),
  (2,'external','rejected','Rejected','Fixture','https://fixture.invalid/rejected',NULL,'unconfirmed',false,'original','original')`);
 await assert.rejects(recordApplicationOutcome('2','same',undefined,'interview'),e=>e instanceof ApplicationOutcomeError&&e.status===409);
 await assert.rejects(recordApplicationOutcome('4','same','external','interview'),e=>e instanceof ApplicationOutcomeError&&e.status===404);
 await assert.rejects(recordApplicationOutcome('2','same','external','invented'),ApplicationOutcomeError);
 await assert.rejects(recordApplicationOutcome('2','same','external','closed'),ApplicationOutcomeError);
 assert.equal(await recordApplicationOutcome('2','same','external','interview'),true);
 assert.equal(await recordApplicationOutcome('2','same','external','interview'),false,'replayed outcome is idempotent');
 let rows=await query('SELECT * FROM applications ORDER BY id');
 const changed=rows.find(r=>r.user_id==='2'&&r.platform==='external'&&r.job_id==='same')!;
 assert.equal(changed.outcome,'interview');assert.equal(changed.confirmation_status,null);assert.equal(changed.submitted_by_myasis,true);
 assert.equal(changed.applied_at,'original timestamp');assert.equal(changed.cover_letter,'original letter');
 assert.equal(rows.find(r=>r.user_id==='2'&&r.platform==='indeed')!.outcome,null);
 assert.equal(rows.find(r=>r.user_id==='3')!.outcome,null);
 let audit=await query('SELECT * FROM run_events');assert.equal(audit.length,1);assert.match(audit[0].reason,/confirmed by the candidate/);
 assert.equal(await recordApplicationOutcome('2','rejected','external','rejected'),true);
 await query("UPDATE applications SET cover_letter=NULL WHERE job_id='rejected'");
 const migration=readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8').match(/UPDATE applications SET submitted_by_myasis = false WHERE score = 0[^;]+;/)![0];
 await query(migration);await query(migration);
 const confirmedRejection=(await query("SELECT * FROM applications WHERE job_id='rejected'"))[0];
 assert.equal(confirmedRejection.submitted_by_myasis,true,'repeat deployment migrations preserve candidate-confirmed outcomes without a recorded letter or score');
 await assert.rejects(recordApplicationOutcome('2','rollback','external','interview'),/check constraint/);
 const rolledBack=(await query("SELECT * FROM applications WHERE job_id='rollback'"))[0];
 assert.equal(rolledBack.outcome,null);assert.equal(rolledBack.confirmation_status,'unconfirmed');assert.equal(rolledBack.submitted_by_myasis,false);
 assert.equal(await recordApplicationOutcome('2','same','external',null),true,'clearing a recorded outcome preserves known delivery');
 rows=await query("SELECT * FROM applications WHERE user_id=2 AND platform='external' AND job_id='same'");
 assert.equal(rows[0].confirmation_status,null);assert.equal(rows[0].submitted_by_myasis,true);
 console.log('PASS: candidate-confirmed interview/rejection, owner/platform isolation, immutable application content, idempotent human audit and atomic rollback; temporary PostgreSQL tables only.');
}finally{await pool.end();}
