import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getPool } from './db/index.js';
import { userDir } from './userdata.js';
import { sendAutomaticApplicationEmail } from './application-email.js';
import { encryptGmailToken } from './gmail-connection.js';
import { applicationRevision } from '../../seek-bot/src/application-review-content.js';
import { OAuth2Client, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from '../../seek-bot/src/gmail-mcp-client.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';

test('live Auto email uses existing receipt/credit ledger without confirmation or duplicate sends', async () => {
  const owner = `automatic-mail-fixture-${process.pid}`, directory = userDir(owner), pool = getPool();
  const original = {query:pool.query,connect:pool.connect,request:OAuth2Client.prototype.request,key:process.env.GMAIL_TOKEN_ENCRYPTION_KEY,public:process.env.GMAIL_MCP_PUBLIC_ENABLED};
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64'); process.env.GMAIL_MCP_PUBLIC_ENABLED='true';
  const encrypted = encryptGmailToken(owner, 'fixture-refresh-token');
  const resume = Buffer.from('Exact synthetic selected resume');
  mkdirSync(join(directory,'resumes'),{recursive:true}); writeFileSync(join(directory,'resumes','CV.txt'),resume);
  const reviews = new Map<string, {id:string;status:string;payload:PreparedApplication;credit_consumed:boolean}>();
  const sends = new Map<string, {status:string;message_id?:string;thread_id?:string;source_run_id?:string|null}>();
  const sources = new Map<string,string|null>();
  const applied = new Set<string>(); let ended=false,attempts=0,credits=0,externalCredits=0,uncertain=false;
  const sql = async (statement:string, params:any[]=[]) => {
    if (statement.includes('FROM new_user_trials')) return {rows:[]};
    if (['BEGIN','COMMIT','ROLLBACK'].includes(statement) || statement.startsWith('SELECT pg_advisory')) return {rows:[]};
    if (statement.includes('FROM run_starts r JOIN users')) return {rows:params[0]===owner && params[1]==='1001' && !ended ? [{id:'1001'}] : []};
    if (statement.includes('FROM bonus_runs')) return {rows:[]};
    if (statement.includes('FROM application_review_operator_holds')) return {rows:[]};
    if (statement.startsWith('SELECT id::text,status,payload FROM application_reviews')) return {rows:reviews.has(params[1])?[reviews.get(params[1])]:[]};
    if (statement.startsWith('INSERT INTO application_reviews')) {
      const payload=JSON.parse(params[3]); if(reviews.has(params[1]))return {rows:[]};
      reviews.set(params[1],{id:params[2],status:'ready',payload,credit_consumed:false}); return {rows:[{credit_consumed:false}]};
    }
    if (statement.startsWith('UPDATE application_reviews SET credit_consumed')) { reviews.get(params[1])!.credit_consumed=true; return {rows:[]}; }
    if (statement.startsWith("UPDATE application_reviews SET status='approved'")) { const row=[...reviews.values()].find(r=>r.id===params[1]); if(row)row.status='approved'; return {rows:[]}; }
    if (statement.startsWith('SELECT status,payload,credit_consumed FROM application_reviews')) return {rows:params[0]===owner?[...reviews.values()].filter(r=>r.id===params[1]):[]};
    if (statement.includes("p.plan_key = 'intensive-pass'")) return {rows:[{active:false}]};
    if (statement.includes('FROM employer_site_credit_grants')) return {rows:[{id:'external'}]};
    if (statement.includes('FROM monthly_application_usage')) return {rows:[{used:'5'}]};
    if (statement.includes('FROM application_credit_grants') && statement.includes('FOR UPDATE')) return {rows:[{id:'paid'}]};
    if (statement.startsWith('UPDATE application_credit_grants')) {credits++;return {rows:[]};}
    if (statement.startsWith('UPDATE employer_site_credit_grants')) {externalCredits++;return {rows:[]};}
    if (statement.includes('FROM users u LEFT JOIN profiles')) return {rows:[{email:'candidate@fixture.invalid',profile_email:'candidate@fixture.invalid'}]};
    if (statement.startsWith('SELECT email FROM users')) return {rows:[{email:'candidate@fixture.invalid'}]};
    if (statement.includes('FROM users u WHERE u.id=$1')) return {rows:[{email:'candidate@fixture.invalid',active_search:false,intensive:false}]};
    if (statement.startsWith('SELECT key,value FROM settings')) return {rows:[]};
    if (statement.startsWith('SELECT gmail_email')) return {rows:[{current:true,same_address:true,gmail_email:'candidate@fixture.invalid',scope:`${GMAIL_READ_SCOPE} ${GMAIL_SEND_SCOPE}`,last_error:null}]};
    if (statement.includes('FROM google_connections g JOIN users')) return {rows:[{refresh_token:encrypted,scope:`${GMAIL_READ_SCOPE} ${GMAIL_SEND_SCOPE}`}]};
    if (statement.startsWith('SELECT email FROM profiles')) return {rows:[{email:'candidate@fixture.invalid'}]};
    if (statement.includes('FROM resumes WHERE user_id')) return {rows:[{id:'cv',label:'Selected CV',file_name:'CV.txt',uploaded_at:new Date(),size_bytes:resume.length}]};
    if (statement.startsWith('SELECT status,message_id,thread_id FROM application_email_sends')) return {rows:sends.has(params[1]+':'+params[2])?[sends.get(params[1]+':'+params[2])]:[]};
    if (statement.startsWith('SELECT id FROM applications')) return {rows:applied.has(params[2])?[{id:1}]:[]};
    if (statement.startsWith('SELECT status FROM application_email_sends')) return {rows:[]};
    if (statement.startsWith('INSERT INTO application_email_sends')) {const key=params[1]+':'+params[2];if(sends.has(key))return {rows:[]};sends.set(key,{status:'sending',source_run_id:params[4]??null});return {rows:[{status:'sending'}]};}
    if (statement.startsWith("UPDATE application_email_sends SET status='sent'")) {const key=params[1]+':'+params[2];sends.set(key,{...sends.get(key),status:'sent',message_id:params[3],thread_id:params[4]});return {rows:[]};}
    if (statement.startsWith('UPDATE application_email_sends SET status=$4')) {const key=params[1]+':'+params[2];sends.set(key,{...sends.get(key),status:params[3]});return {rows:[]};}
    if (statement.startsWith('INSERT INTO applications')) {if(!applied.has(params[1]))sources.set(params[1],sends.get(params[10]+':'+params[11])?.source_run_id??null);applied.add(params[1]);return {rows:[]};}
    if (statement.startsWith("UPDATE application_reviews SET status='applied'")) {const row=[...reviews.values()].find(r=>r.id===params[1]);row!.status='applied';return {rows:[]};}
    if (statement.startsWith('SELECT count(*)::text AS n')) return {rows:[{n:String(applied.size)}]};
    if (statement.startsWith('UPDATE google_connections SET last_error')) return {rows:[]};
    throw Error('Unrecognised fixture SQL: '+statement);
  };
  pool.query=sql as unknown as typeof pool.query;
  pool.connect=(async()=>({query:sql,release(){}})) as unknown as typeof pool.connect;
  OAuth2Client.prototype.request=(async(request:{url:string;data?:{raw:string}})=>{
    if(request.url.endsWith('/messages/send')){
      attempts++;const mime=Buffer.from(request.data!.raw,'base64url').toString('utf8');
      assert.match(mime,/To: <careers@fixture.invalid>/);assert.ok(mime.includes(resume.toString('base64')));
      if(uncertain)throw Error('Synthetic lost receipt');return {data:{id:`sent-${attempts}`,threadId:'thread'}};
    }
    if(request.url.endsWith('/messages'))return {data:{messages:[]}};
    throw Error('Non-fixture Gmail request');
  }) as unknown as typeof OAuth2Client.prototype.request;
  const draft=(job:string):PreparedApplication=>{
    const d:PreparedApplication={id:randomUUID(),revision:'',job:{id:job,title:'Developer',company:'Fixture',location:'Sydney',url:'https://employer.fixture.invalid/job',platform:'jora',applicationMode:'external'},preparedAt:new Date().toISOString(),formUrl:'https://employer.fixture.invalid/job',answers:[],coverLetter:'The selected candidate letter.',resume:'CV.txt',resumeId:'cv',resumeHash:createHash('sha256').update(resume).digest('hex'),email:{to:'careers@fixture.invalid',subject:'Developer application'}};
    d.revision=applicationRevision(d);return d;
  };
  try {
    const first=draft('first');
    await assert.rejects(sendAutomaticApplicationEmail('foreign','1001',first),/does not belong/);
    ended=true;await assert.rejects(sendAutomaticApplicationEmail(owner,'1001',first),/ended/);ended=false;
    assert.equal(credits,0);assert.equal(attempts,0);
    assert.equal((await sendAutomaticApplicationEmail(owner,'1001',first)).messageId,'sent-1');
    assert.equal(reviews.get('jora:first')!.status,'applied');assert.equal(reviews.get('jora:first')!.payload.autoRunId,'1001');
    assert.equal(credits,1);assert.equal(externalCredits,1);assert.ok(applied.has('first'));
    assert.equal(sources.get('first'),'1001','Auto mail binds to its validated current live run');
    assert.equal((await sendAutomaticApplicationEmail(owner,'1001',{...first,id:randomUUID()})).alreadySent,true);
    assert.equal(attempts,1);assert.equal(credits,1,'replayed sends do not consume another credit');
    const manual=draft('manual');reviews.set('jora:manual',{id:manual.id,status:'ready',payload:manual,credit_consumed:true});
    await assert.rejects(sendAutomaticApplicationEmail(owner,'1001',manual),/retained application/);
    assert.equal(reviews.get('jora:manual')!.status,'ready','existing Semi auto drafts are not silently converted');
    uncertain=true;const lost=draft('lost');
    await assert.rejects(sendAutomaticApplicationEmail(owner,'1001',lost),/could not be confirmed/);
    await assert.rejects(sendAutomaticApplicationEmail(owner,'1001',lost),/prior email send/);
    assert.equal(attempts,2);assert.equal(credits,2,'failed receipt retries retain their exact existing credit');
    assert.equal(reviews.get('jora:lost')!.status,'approved','Auto failures never become Ready for confirmation');
    console.log('PASS: active-run/owner authorization, Auto receipt persistence, exact selected resume, one credit per email, idempotent retry, uncertain-send protection and unchanged existing Semi auto drafts.');
  } finally {
    pool.query=original.query;pool.connect=original.connect;OAuth2Client.prototype.request=original.request;
    for(const [key,value] of [['GMAIL_TOKEN_ENCRYPTION_KEY',original.key],['GMAIL_MCP_PUBLIC_ENABLED',original.public]])if(value===undefined)delete process.env[key!];else process.env[key!]=value;
    rmSync(directory,{recursive:true,force:true});await pool.end();
  }
});
