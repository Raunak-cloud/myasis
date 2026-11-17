import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {getPool} from './db/index.js';
import {googleAuthUrl,handleGoogleCallback} from './auth.js';
import {billingStatus} from './billing.js';
import {freeTrialOffer,verifiedSeekConnection} from './free-trial.js';
import {consumeApplicationCredit} from './application-credits.js';
import {deriveEntitlements,applyRunPolicy,effectivePlatforms} from './entitlements.js';
import {RUN_SETTING_DEFAULTS} from './settings.js';
import {availableJobSources,applyJobSourceAccess} from './job-sources.js';
import {mayRunEmployerSiteApplications} from './employer-site-access.js';
import {userDir} from './userdata.js';
import {saveApplicationReview,applicationsForConfirmation,claimApplicationReviews} from './application-reviews.js';
import type {PreparedApplication} from '../../seek-bot/src/application-review-types.js';

test('new-user trial: atomic signup, employer-only defaults, shared five credits, verified one-time SEEK six, concurrent consumption and legacy isolation',async()=>{
 const pool=getPool(),schema='trial_test_'+randomUUID().replaceAll('-','');
 (pool as unknown as {options:{options:string}}).options.options=`-c search_path=${schema}`;
 const fetcher=globalThis.fetch,env={id:process.env.GOOGLE_CLIENT_ID,secret:process.env.GOOGLE_CLIENT_SECRET};
 process.env.GOOGLE_CLIENT_ID='fixture-client';process.env.GOOGLE_CLIENT_SECRET='fixture-secret';
 const states:string[]=[];
 try{
  await pool.query(`CREATE SCHEMA ${schema};CREATE TABLE users(id BIGSERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT,avatar_url TEXT,google_id TEXT UNIQUE,last_login_at TIMESTAMPTZ,blocked_at TIMESTAMPTZ);ALTER SEQUENCE users_id_seq RESTART WITH 9000000000;`);
  const sql=readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8');
  for(const table of ['sessions','new_user_trials','billing_purchases','billing_checkout_intents','application_credit_grants','employer_site_credit_grants','monthly_application_usage','run_starts','application_reviews','application_review_operator_holds'])await pool.query(sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
  let email='new@trial.fixture.invalid',subject='new-subject';
  globalThis.fetch=(async url=>new Response(JSON.stringify(String(url).includes('/token')?{access_token:'fixture-token'}:{sub:subject,email,email_verified:true,name:'Trial Candidate'}),{headers:{'content-type':'application/json'}})) as typeof fetch;
  const signup=async()=>{const auth=googleAuthUrl();assert(auth.ok);return handleGoogleCallback('fixture-code',new URL(auth.url).searchParams.get('state'),auth.cookie.split(';')[0]);};
  const created=await signup();assert(created.ok&&created.signedUp);const uid=String(created.userId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM new_user_trials WHERE user_id=$1',[uid])).rows[0].n,1);
  assert.equal((await signup()).signedUp,false);assert.equal((await pool.query('SELECT count(*)::int AS n FROM new_user_trials WHERE user_id=$1',[uid])).rows[0].n,1);
  const initial=await billingStatus(uid,email);assert.equal(initial.free.remaining,5);assert.equal(initial.free.allowance,5);assert.equal(initial.free.trial?.seekBonusAwarded,false);assert.equal(initial.paid.hasActivePass,false);
  const facts={admin:false,billing:initial,autoRunsUsedToday:0,autoApplyPaused:true,hasSuccessfulRun:false,overrides:{evaluationsPerRun:null,maxApplicationsPerRun:null},searchTermSuggestionsLeft:1};
  const entitled=deriveEntitlements(facts);assert.equal(entitled.employerSources,true);assert.equal(entitled.indeedApplications,false);assert.equal(entitled.fineTune,false);
  const settings=applyRunPolicy({...RUN_SETTING_DEFAULTS},entitled,'auto');applyJobSourceAccess(settings,false,entitled.employerSources);
  const sources=settings.PLATFORMS.split(',');assert(sources.includes('workday')&&sources.includes('pageup')&&sources.includes('smartrecruiters'));assert(!sources.includes('seek')&&!sources.includes('indeed'));
  assert.deepEqual(availableJobSources(sources,true,()=>false).usable,sources,'no job-board sign-in is required');
  assert.equal(applyRunPolicy({...RUN_SETTING_DEFAULTS,PLATFORMS:'pageup'},entitled,'auto',true,true).PLATFORMS,'pageup','trial source choices are saved without changing other plan controls');
  assert.equal(effectivePlatforms({PLATFORMS:'pageup,indeed',PLATFORMS_CHOSEN:'1'},entitled),'pageup','source choices do not grant a paid Indeed entitlement');
  assert.equal(mayRunEmployerSiteApplications({targetIsAdmin:false,initiatedByAdmin:false,hasIntensiveAllowance:false,hasFreeEmployerAllowance:true}),true);
  const consume=async(external:boolean)=>{const c=await pool.connect();try{await c.query('BEGIN');await consumeApplicationCredit(c,uid,external);await c.query('COMMIT');return true;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}};
  for(let i=0;i<4;i++)await consume(true);
  const race=await Promise.allSettled([consume(true),consume(true)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1,'only one caller can spend the final free credit');
  assert.equal((await billingStatus(uid,email)).free.remaining,0);
  const stateFile=userDir(uid)+'/seek-session.json';mkdirSync(userDir(uid),{recursive:true});states.push(stateFile);
  const write=(source:string,signedIn=true,account:string|null='candidate@seek.fixture.invalid')=>writeFileSync(stateFile,JSON.stringify({source,signedIn,account,checkedAt:new Date().toISOString()}));
  write('declared');assert.equal((await freeTrialOffer(uid))?.seekBonusAwarded,false,'pressing Done without observed proof does not earn credits');
  write('run',false);assert.equal((await freeTrialOffer(uid))?.seekBonusAwarded,false);
  write('run',true,null);assert.equal((await freeTrialOffer(uid))?.seekBonusAwarded,false);
  write('run');const grants=await Promise.all(Array.from({length:8},()=>freeTrialOffer(uid)));assert(grants.every(v=>v?.seekBonusAwarded));
  const connected=await billingStatus(uid,email);assert.equal(connected.free.allowance,11);assert.equal(connected.free.remaining,6);
  const connectedEntitlements=deriveEntitlements({...facts,billing:connected});assert(effectivePlatforms({},connectedEntitlements).split(',').includes('seek'));
  assert.equal(effectivePlatforms({PLATFORMS:'pageup',PLATFORMS_CHOSEN:'1'},connectedEntitlements),'pageup','explicit source choices remain unchanged');
  write('run',false);assert.equal((await billingStatus(uid,email)).free.remaining,6,'earned bonus survives disconnection');
  for(let i=0;i<6;i++)await consume(i%2===0);
  write('run');const exhausted=await billingStatus(uid,email);assert.equal(exhausted.free.used,11);assert.equal(exhausted.free.remaining,0);assert.equal(exhausted.free.allowance,11);assert.equal(deriveEntitlements({...facts,billing:exhausted}).employerSources,false);
  await assert.rejects(consume(false),/No application allowance/);await assert.rejects(consume(true),/No employer-site/);
  email='legacy@trial.fixture.invalid';subject='legacy-subject';const legacy=String((await pool.query('INSERT INTO users(email) VALUES($1) RETURNING id',[email])).rows[0].id);
  const linked=await signup();assert(linked.ok&&!linked.signedUp);assert.equal(String(linked.userId),legacy);assert.equal(await freeTrialOffer(legacy),undefined);
  const legacyStatus=await billingStatus(legacy,email);assert.equal(legacyStatus.free.allowance,5);assert.equal(legacyStatus.free.trial,undefined);assert.equal(deriveEntitlements({...facts,billing:legacyStatus}).employerSources,false);
  assert.equal(verifiedSeekConnection({signedIn:true,source:'declared',account:'candidate@example.org'} as any),false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM new_user_trials')).rows[0].n,1,'returning and migrated accounts never acquire a new trial');
  email='semi@trial.fixture.invalid';subject='semi-subject';const semi=await signup();assert(semi.ok);const semiId=String(semi.userId);
  const draft:PreparedApplication={id:randomUUID(),revision:'a'.repeat(64),job:{id:'fixture-job',platform:'workday',title:'Software Engineer',company:'Fixture Employer',location:'Sydney',url:'https://fixture.invalid/job',applicationMode:'external'},formUrl:'https://fixture.invalid/apply',preparedAt:new Date().toISOString(),answers:[],resume:'Fixture CV.pdf'};
  await saveApplicationReview(semiId,draft);await saveApplicationReview(semiId,draft);
  assert.equal((await billingStatus(semiId,email)).free.remaining,4,'one prepared employer application spends one free credit, even if its save is repeated');
  await pool.query(`UPDATE monthly_application_usage SET successful_applications=5 WHERE user_id=$1`,[semiId]);
  assert.equal((await applicationsForConfirmation(semiId,[{id:draft.id,revision:draft.revision}])).length,1);
  assert.equal((await claimApplicationReviews(semiId,[{id:draft.id,revision:draft.revision}])).length,1,'prepaid employer draft remains confirmable with no unused credits');
  assert.equal((await billingStatus(semiId,email)).free.used,5,'confirmation never spends a second credit');
 }finally{
  globalThis.fetch=fetcher;
  for(const p of states){unlinkSync(p);try{rmdirSync(p.slice(0,p.lastIndexOf('/')));}catch{ /* leave a nonempty directory alone */ }}
  for(const [key,value] of [['GOOGLE_CLIENT_ID',env.id],['GOOGLE_CLIENT_SECRET',env.secret]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();
 }
});
