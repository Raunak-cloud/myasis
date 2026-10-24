import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import config from '../vite.config.js';
import { getPool } from '../server/db/index.js';
import { userDir, USERS_DIR } from '../server/userdata.js';
import { accountRequest, accountUnavailable } from '../server/account-lifecycle.js';
import { runSettingsSnapshotForUser, replaceSearchTermsIfUnchanged } from '../server/settings.js';
import { runner } from '../server/runner.js';
import { applyRunPolicy, entitlementsFor } from '../server/entitlements.js';

const pool = getPool();
const client = await pool.connect();
const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalOrigin = process.env.APP_BASE_URL;
const originalAdmins = process.env.ADMIN_EMAILS;
const schema = `account_settings_api_${randomUUID().replaceAll('-','')}`;
const owner = `${Date.now()}01`, peer = `${Date.now()}02`;
const paths = [owner,peer].map(id => userDir(id));
const created: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query(readFileSync(new URL('../server/db/schema.sql',import.meta.url),'utf8'));
  await client.query("INSERT INTO users(id,email) VALUES($1,'owner@example.test'),($2,'peer@example.test')",[owner,peer]);
  await client.query("INSERT INTO sessions(token,user_id,expires_at) VALUES('owner-token',$1,now()+interval '1 day'),('peer-token',$2,now()+interval '1 day')",[owner,peer]);
  await client.query("INSERT INTO profiles(user_id,full_name) VALUES($1,'Owner'),($2,'Peer')",[owner,peer]);
  // Every real route query goes to this private schema, never to live accounts.
  pool.query = client.query.bind(client) as typeof pool.query;
  pool.connect = (async () => ({query:client.query.bind(client),release() {}})) as unknown as typeof pool.connect;
  const plugin = (config as {plugins:Plugin[]}).plugins.find(p=>p.name==='seek-bot-data-api')!;
  let handler: ((req:unknown,res:unknown,next:()=>void)=>void)|undefined;
  (plugin.configureServer as (server:ViteDevServer)=>void)({middlewares:{use(value:typeof handler) {handler??=value;}},httpServer:null} as unknown as ViteDevServer);
  server=createServer((req,res)=>{ Promise.resolve(handler!(req,res,()=>{res.statusCode=404;res.end();})).catch(()=>{res.statusCode=500;res.end();}); });
  await new Promise<void>(done=>server!.listen(0,'127.0.0.1',done));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  process.env.APP_BASE_URL=origin;
  const request=(path:string,method='GET',body?:unknown,cookie='owner-token',requestOrigin:string|null=origin,contentType='application/json')=>fetch(origin+path,{
    method,headers:{...(cookie?{cookie:`myasis_session=${cookie}`} : {}),...(requestOrigin?{origin:requestOrigin}:{}),...(body===undefined?{}:{'content-type':contentType})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  process.env.ADMIN_EMAILS = 'owner@example.test';
  const oldTerms = 'AI Engineer, Web Developer, Python Developer, Frontend Developer';
  const cappedTerms = 'AI Engineer, Web Developer, Python Developer';
  for (const [id, cookie, unlimited] of [[owner, 'owner-token', true], [peer, 'peer-token', false]] as const) {
    await client.query("INSERT INTO settings(user_id,key,value) VALUES($1,'KEYWORDS',$2)",[id,oldTerms]);
    const shown = await (await request('/api/settings','GET',undefined,cookie)).json() as {KEYWORDS:string};
    assert.equal(shown.KEYWORDS,cappedTerms,'legacy titles are capped in the editor for every tier');
    const snapshot = await runSettingsSnapshotForUser(id,{unlimited});
    assert.equal(snapshot.settings.KEYWORDS,cappedTerms,'manual and scheduled runs use three titles, including unlimited admins');
    assert.equal(snapshot.saved.KEYWORDS,oldTerms,'retain exact saved value for concurrent-edit protection');
    assert.equal(await replaceSearchTermsIfUnchanged(id,snapshot.saved.KEYWORDS,oldTerms),true,'renewal still compares against the original legacy value');
    const response = await request('/api/settings','POST',{updates:{KEYWORDS:oldTerms}},cookie);
    assert.equal(response.status,200);
    const saved = await response.json() as {settings:{KEYWORDS:string}};
    assert.equal(saved.settings.KEYWORDS,cappedTerms);
    assert.equal((await client.query("SELECT value FROM settings WHERE user_id=$1 AND key='KEYWORDS'",[id])).rows[0].value,cappedTerms,'API saves cannot persist a fourth title');
  }
  for (const plan of ['job-search-pass', 'intensive-pass']) {
    const purchase = (await client.query(`INSERT INTO billing_purchases(user_id,stripe_checkout_session_id,plan_key,applications_granted,amount_paid)
      VALUES($1,$2,$3,1,1) RETURNING id`, [peer, `fixture-threshold-${plan}`, plan])).rows[0].id;
    await client.query("INSERT INTO application_credit_grants(user_id,purchase_id,credits_total,credits_used,expires_at) VALUES($1,$2,1,0,now()+interval '60 days')", [peer,purchase]);
    const entitlement = await entitlementsFor(peer, 'peer@example.test');
    assert.equal(entitlement.advancedFilters, true);
    assert.equal(entitlement.scheduledMinScore, 60);
    if (plan === 'intensive-pass') {
      await client.query("INSERT INTO settings(user_id,key,value) VALUES($1,'MAX_APPS_PER_DAY','20') ON CONFLICT(user_id,key) DO UPDATE SET value='20'",[peer]);
      assert.equal((await (await request('/api/settings','GET',undefined,'peer-token')).json() as Record<string,string>).MAX_APPS_PER_DAY,'','an old hidden default does not impose a new daily cap on unlimited access');
    }
    const limits = plan === 'intensive-pass' ? {MAX_AGE_DAYS:'30',MAX_APPS_PER_DAY:'100',PAGES_PER_KEYWORD:'6'} : {MAX_AGE_DAYS:'30'};
    const allowedLimits = await request('/api/settings','POST',{updates:limits},'peer-token');
    assert.equal(allowedLimits.status,200);
    const keptLimits = (await allowedLimits.json() as {settings:Record<string,string>}).settings;
    for (const [key,value] of Object.entries(limits)) assert.equal(keptLimits[key],value);
    if (plan === 'intensive-pass') {
      assert.equal((await (await request('/api/settings','GET',undefined,'peer-token')).json() as Record<string,string>).MAX_APPS_PER_DAY,'100','an explicitly chosen daily cap persists on unlimited access');
      assert.equal(keptLimits.DAILY_APPLICATION_CAP_CHOSEN,'1');
    }
    for (const [key,value] of Object.entries(limits)) assert.equal((await request('/api/settings','POST',{updates:{[key]:String(Number(value)+1)}},'peer-token')).status,400);
    for (const score of ['60', '70', '100']) {
      const response = await request('/api/settings','POST',{updates:{MIN_SCORE:score}},'peer-token');
      assert.equal(response.status,200);
      assert.equal((await response.json() as {settings:{MIN_SCORE:string}}).settings.MIN_SCORE,score);
      const shown = await (await request('/api/settings','GET',undefined,'peer-token')).json() as Record<string,string>;
      assert.equal(shown.MIN_SCORE,score);
      assert.equal(applyRunPolicy(shown,entitlement,'auto').MIN_SCORE,score,'scheduled runs honour the score saved through the real API');
    }
    for (const score of ['59', '101', '', 'NaN']) {
      assert.equal((await request('/api/settings','POST',{updates:{MIN_SCORE:score}},'peer-token')).status,400);
      assert.equal((await client.query("SELECT value FROM settings WHERE user_id=$1 AND key='MIN_SCORE'",[peer])).rows[0].value,'100','invalid thresholds never overwrite the saved choice');
    }
    await client.query('DELETE FROM application_credit_grants WHERE purchase_id=$1',[purchase]);
    await client.query('DELETE FROM billing_purchases WHERE id=$1',[purchase]);
  }
  assert.equal((await request('/api/settings','POST',{updates:{MIN_SCORE:'22'}},'owner-token')).status,200,'admin diagnostic thresholds remain available');
  for (const [key,max] of Object.entries({MAX_AGE_DAYS:30,MAX_APPS_PER_DAY:100,PAGES_PER_KEYWORD:6})) {
    assert.equal((await request('/api/settings','POST',{updates:{[key]:String(max)}},'owner-token')).status,200);
    assert.equal((await request('/api/settings','POST',{updates:{[key]:String(max+1)}},'owner-token')).status,400,'admins use the same configurable maximum');
  }
  if(originalAdmins===undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS=originalAdmins;
  for(const path of ['/api/daily-summary','/api/account']) assert.equal((await request(path,'GET',undefined,'')).status,401);
  assert.equal((await request('/api/daily-summary','DELETE')).status,405);
  assert.equal((await request('/api/account','POST',{})).status,405);
  assert.deepEqual(await (await request('/api/daily-summary')).json(),{enabled:true});
  assert.equal((await request('/api/daily-summary','POST',{enabled:'off'})).status,400);
  assert.equal((await request('/api/daily-summary','POST',{enabled:false},'owner-token','https://other.invalid')).status,403);
  assert.equal((await request('/api/daily-summary','POST',{enabled:false},'owner-token',null)).status,403);
  assert.deepEqual(await (await request(`/api/daily-summary?userId=${peer}`,'POST',{enabled:false,userId:peer})).json(),{enabled:false});
  assert.deepEqual(await (await request('/api/daily-summary','GET',undefined,'peer-token')).json(),{enabled:true},'another account keeps its summary preference');
  assert.deepEqual(await (await request('/api/email-alerts')).json(),{enabled:true},'attention alerts remain independent');
  assert.deepEqual(await (await request('/api/daily-summary','POST',{enabled:true})).json(),{enabled:true});
  assert.deepEqual(await (await request(`/api/account?userId=${peer}`)).json(),{email:'owner@example.test'});
  assert.equal((await request('/api/account','DELETE',{confirmEmail:'peer@example.test'})).status,400);
  for(const badOrigin of [null,'https://other.invalid','chrome-extension://fixture']) {
    assert.equal((await request('/api/account','DELETE',{confirmEmail:'owner@example.test'},'owner-token',badOrigin)).status,403);
  }
  assert.equal((await request('/api/account','DELETE',{confirmEmail:'owner@example.test'},'owner-token',origin,'text/plain')).status,403);
  for(const path of paths) {
    assert.equal(dirname(path),resolve(USERS_DIR));
    assert.equal(existsSync(path),false,'only create brand-new isolated fixture directories');
    mkdirSync(path,{recursive:true}); created.push(path); writeFileSync(resolve(path,'fixture-only.txt'),'isolated account fixture');
  }
  // The start claim prevents this synthetic account from launching any browser.
  assert.equal((await request('/api/auto-apply','POST',{enabled:true,applicationMode:'auto'})).status,400);
  assert.equal((await request('/api/auto-apply','POST',{enabled:true,confirm:true,applicationMode:'semi-auto'})).status,428);
  assert.equal((await request('/api/auto-apply','POST',{enabled:false},'owner-token','https://other.invalid')).status,403);
  await client.query("UPDATE profiles SET email='owner@example.test',phone='0400000000',work_rights='Fixture rights',experience_summary='Fixture experience',expected_salary='70000' WHERE user_id=$1",[owner]);
  await client.query("INSERT INTO resumes(user_id,label,file_name) VALUES($1,'Fixture CV','fixture-only.txt')",[owner]);
  await client.query("INSERT INTO settings(user_id,key,value) VALUES($1,'ONSITE_CITY','Sydney'),($1,'WORK_ARRANGEMENTS','remote')",[owner]);
  assert.equal(runner.claimStart(owner),true);
  try {
    const enabled=await request('/api/auto-apply','POST',{enabled:true,confirm:true,applicationMode:'semi-auto',userId:peer});
    assert.equal(enabled.status,200);
    assert.equal((await enabled.json() as {entitlements:{autoApplyPaused:boolean}}).entitlements.autoApplyPaused,false);
    const ownSchedule=await (await request('/api/auto-schedule')).json() as {enabled:boolean;applicationMode:string};
    assert.equal(ownSchedule.enabled,true); assert.equal(ownSchedule.applicationMode,'semi-auto');
    assert.equal((await (await request('/api/auto-schedule','GET',undefined,'peer-token')).json() as {enabled:boolean}).enabled,false);
    assert.equal((await request('/api/auto-apply','POST',{enabled:true,confirm:true,applicationMode:'auto'})).status,409);
    assert.equal((await request('/api/auto-apply','POST',{enabled:false})).status,200);
    assert.equal((await (await request('/api/auto-schedule')).json() as {enabled:boolean}).enabled,false);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM run_starts WHERE user_id=$1',[owner])).rows[0].n,0);
  } finally { runner.releaseStart(owner); }
  const site=randomUUID(),job=randomUUID();
  await client.query("INSERT INTO marketing_sites(id,user_id,url,cta_url) VALUES($1,$2,'https://fixture.invalid','https://fixture.invalid')",[site,owner]);
  await client.query("INSERT INTO marketing_jobs(id,site_id,user_id,kind,status,idempotency_key) VALUES($1,$2,$3,'research','running','api-fixture')",[job,site,owner]);
  const busy=await request('/api/account','DELETE',{confirmEmail:'owner@example.test'});
  assert.equal(busy.status,409);
  assert.equal(busy.headers.get('set-cookie'),null,'a failed deletion does not log out the owner');
  assert.equal((await request('/api/account')).status,200,'a refused deletion remains retryable');
  assert.equal(existsSync(paths[0]),true);
  await client.query("UPDATE marketing_jobs SET status='done'");
  let finishUpload!:()=>void;
  const upload=accountRequest(owner,()=>new Promise<void>(done=>{finishUpload=()=>{writeFileSync(resolve(paths[0],'last-upload.txt'),'private upload');done();};}));
  await Promise.resolve();
  const deleting=request(`/api/account?userId=${peer}`,'DELETE',{confirmEmail:' OWNER@example.test ',userId:peer});
  const deadline=Date.now()+5000;
  while(!accountUnavailable(owner) && Date.now()<deadline) await new Promise(done=>setTimeout(done,5));
  assert.equal(accountUnavailable(owner),true);
  assert.equal(existsSync(paths[0]),true,'a pending upload must settle before its account files are removed');
  finishUpload(); await upload;
  const deleted=await deleting;
  assert.equal(deleted.status,200);
  assert.deepEqual(await deleted.json(),{ok:true});
  assert.match(deleted.headers.get('set-cookie')??'',/myasis_session=;.*Max-Age=0/);
  assert.equal((await request('/api/account')).status,401,'all deleted-account sessions are invalid');
  assert.equal((await request('/api/daily-summary')).status,401);
  assert.equal((await client.query('SELECT * FROM users WHERE id=$1',[owner])).rowCount,0);
  assert.equal((await client.query('SELECT * FROM profiles WHERE user_id=$1',[owner])).rowCount,0);
  assert.equal(existsSync(paths[0]),false);
  assert.equal(existsSync(resolve(paths[1],'fixture-only.txt')),true);
  assert.deepEqual(await (await request('/api/account','GET',undefined,'peer-token')).json(),{email:'peer@example.test'});
  console.log('PASS: real account Settings API, private PostgreSQL schema, authentication, CSRF, strict values, email confirmation, busy/retry, owner isolation, session invalidation and file deletion.');
} finally {
  if(server) await new Promise<void>(done=>server!.close(()=>done()));
  pool.query=originalQuery; pool.connect=originalConnect;
  if(originalOrigin===undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL=originalOrigin;
  if(originalAdmins===undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS=originalAdmins;
  await client.query('ROLLBACK').catch(()=>{});
  await client.query('SET search_path TO public');
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release(); await pool.end();
  for(const path of created) {
    assert.equal(dirname(path),resolve(USERS_DIR));
    if(existsSync(resolve(path,'fixture-only.txt'))) rmSync(path,{recursive:true,force:true});
  }
}
