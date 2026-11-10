import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Real startRun + retry resolver with offline process/DB/browser boundaries.
 * No run process, provider, database, candidate or employer is contacted. */
test('normal startRun resolves retained metadata and still enforces mode, account and allowance guards', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'targeted-retry-start-')), owner = join(directory, '183');
  const id = '95593975', attemptId = '11111111-1111-4111-8111-111111111111';
  const metadata = { job_id: id, title: 'Data Analyst', company: 'Fixture Employer' };
  const trace = { jobId: id, title: metadata.title, company: metadata.company,
    job: { id, title: metadata.title, company: metadata.company, platform: 'seek', url: `https://www.seek.com.au/job/${id}`, fitReview: { decision: 'historical-do-not-reuse' } },
    attemptId, runStartId: '1145', outcome: { status: 'skipped' }, sendAudit: { attempted: false, phase: 'before-tools' }, steps: [] };
  mkdirSync(join(owner, 'traces'), { recursive: true });
  const alias = join(owner, 'traces', `${id}.json`);
  writeFileSync(alias, JSON.stringify(trace));
  writeFileSync(join(owner, 'traces', `attempt-${attemptId}.json`), JSON.stringify(trace));
  const url = (name: string) => pathToFileURL(join(directory, name)).href;
  const sourceUrl = (specifier: string) => new URL(specifier.replace(/\.js$/, '.ts'), import.meta.url).href;
  const compile = (file: string, destination: string, bindings: Record<string, string>, retain: string[] = []) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText
      .replace(/from ['"]([^'"]+)['"]/g, (original, specifier: string) => specifier.startsWith('node:') ? original
        : `from ${JSON.stringify(bindings[specifier] ?? (retain.includes(specifier) ? sourceUrl(specifier) : url('boundary.mjs')))}`);
    writeFileSync(join(directory, destination), output);
  };
  try {
    writeFileSync(join(directory, 'boundary.mjs'), `
export const state={credits:5,sent:0,busy:false,starts:[],queries:[],events:[],pending:['seek:held-fixture'],repairs:[],approvedDrafts:[]};
export const approvedRunRepairs=async()=>state.repairs;
export const query=async(sql,params)=>{state.queries.push({sql,params});if(sql.includes('FROM run_events'))return state.events;
  if(sql.includes('UPDATE run_starts SET operator_options'))return [];
  if(sql.includes('FROM run_starts'))return [{id:'1145',user_id:'183',finished_at:'2026-11-02T17:45:00Z'}];
  if(sql.includes('FROM users'))return [{email:'operator@fixture.invalid'}];throw Error('Unexpected fixture query');};
export const userDir=id=>{if(id!=='183')throw Error('Foreign fixture owner');return ${JSON.stringify(owner)};};
export const runner={claimStart:()=>!state.busy,releaseStart:()=>{},inUse:()=>state.busy,start:async(...args)=>{state.starts.push(args);return {ok:true};}};
export const readEnv=()=>({}),adzunaConfigured=()=>false;
export const runSettingsSnapshotForUser=async()=>({settings:{KEYWORDS:'data analyst',MAX_AGE_DAYS:'15',MIN_SCORE:'70'},saved:{}});
export const USER_SETTABLE_SETTINGS_KEYS=[],DAILY_APPLICATION_CAP_CHOSEN='fixture-daily';
export const billingStatus=async()=>({totalRemaining:state.credits,paid:{remaining:state.credits,hasActiveIntensivePass:true,employerSiteRemaining:5},free:{remaining:0}});
export const consumeSuccessfulApplication=async()=>{throw Error('A fixture cannot charge an application');},isAdmin=email=>email==='operator@fixture.invalid';
export const applyRunPolicy=settings=>({...settings,PLATFORMS:'seek',MAX_APPS_PER_RUN:'5',MAX_APPS_PER_DAY:'100'});
export const PLATFORMS_CHOSEN_KEY='platforms-chosen',EMPLOYER_SOURCES_CHOSEN_KEY='sources-chosen',INTENSIVE_EMPLOYER_SITES_PER_DAY=5;
export const discardRunStart=async()=>{},recordRunStart=async()=> 'fixture-new-run';
export const entitlementsFor=async()=>({tier:'intensive',employerSources:true,fineTune:true,manualRuns:true,firstRunRequired:false,autoRunsPerDay:4});
export const mayEditRunSetting=()=>false,listResumes=async()=>[{id:'fixture-resume'}];
export const checkSignin=async()=>{throw Error('Fixture browser access is forbidden');},waitForSigninChecks=async()=>({ok:true});
export const sessionFor=()=>null,stopSignin=async()=>{throw Error('Fixture cannot stop sign-in');};
export const externalSubmittedToday=async()=>0,submittedToday=async()=>state.sent,readSiteState=()=>({signedIn:true});
export const browserRoute=async()=>({}),describeRoute=()=>'',releaseFreeProxy=async()=>{};
export const validateExternalJobUrl=async()=>{throw Error('No direct external fixture');};
export const applyJobSourceAccess=()=>{},jobSourceSettingsError=()=>null;
export const availableJobSources=boards=>({supported:boards,unavailable:[],usable:boards});
export const loadProfile=async()=>({expectedSalary:'90000'});
export class ApplicationReviewError extends Error{};
export const applicationsForConfirmation=async()=>state.approvedDrafts,claimApplicationReviews=async()=>state.approvedDrafts,pendingReviewKeys=async()=>state.pending,releaseApplicationReviews=async()=>{},reviewSelection=value=>value;
export const gmailAccess=async()=>({connected:false}),scheduledStart=async()=>{throw Error('No scheduled fixture');};
`);
    compile('./targeted-retry-jobs.ts', 'targeted.mjs', { './db/index.js': url('boundary.mjs'), './userdata.js': url('boundary.mjs') },
      ['../../seek-bot/src/job-board-url.js', '../../seek-bot/src/repair-safety.js', './run-diagnostics.js']);
    compile('./targeted-retry-indeed.ts','indeed.mjs',{'./db/index.js':url('boundary.mjs')},['../../seek-bot/src/job-board-url.js']);
    compile('./start-run.ts', 'start.mjs', { './targeted-retry-jobs.js': url('targeted.mjs'),'./targeted-retry-indeed.js':url('indeed.mjs') },
      ['../../seek-bot/src/application-model-catalog.js', '../../seek-bot/src/employer-source-config.js', '../src/salary.js',
        '../../seek-bot/src/job-board-url.js', '../../seek-bot/src/cover-letter-policy.js', '../../seek-bot/src/run-limits.js', '../../seek-bot/src/discovery-seeds.js', './employer-site-access.js', './operator-run-plan.js', './operator-application-budget.js']);
    const { startRun } = await import(url('start.mjs')) as typeof import('./start-run.js');
    const { state } = await import(url('boundary.mjs'));
    const request = { userId: '183', email: 'candidate@fixture.invalid', trigger: 'admin' as const, startedBy: '1', mode: 'live' as const,
      applicationMode: 'semi-auto' as const, jobIds: [id], scope: 'external' };
    assert.deepEqual(await startRun(request), { ok: true, mode: 'live' });
    assert.equal(state.starts.length, 1);
    const overrides = state.starts[0][1];
    assert.deepEqual(JSON.parse(overrides.TARGET_SEEK_JOBS), [metadata]);
    assert.equal(overrides.APPLICATION_REVIEW_MODE, 'prepare', 'historical evidence never grants submission approval');
    assert.equal(overrides.MAX_AGE_DAYS, '15'); assert.equal(overrides.MIN_SCORE, '70');
    assert.equal(overrides.APPLY_ONLY, 'external'); assert.equal(overrides.PLATFORMS, 'seek');
    assert.deepEqual(JSON.parse(overrides.PENDING_APPLICATION_KEYS_JSON), state.pending, 'existing pending/hold exclusions survive targeting');
    assert.equal(overrides.INCLUDE_SAVED_CHOICES, 'true', 'ordinary runs keep explicit saved choices');
    assert.deepEqual(await startRun({ ...request, oneTime: { includeSavedChoices: false } }), { ok: true, mode: 'live' });
    assert.equal(state.starts.at(-1)[1].INCLUDE_SAVED_CHOICES, 'false', 'authenticated operator can scope only this run to preference-based discovery');
    assert.equal(state.starts.at(-1)[1].APPLICATION_REVIEW_MODE, 'prepare', 'selection scope does not grant sending authority');
    assert.deepEqual(await startRun({ ...request, oneTime: { applicationModel: 'minimax' } }), { ok: true, mode: 'live' });
    assert.equal(state.starts.at(-1)[1].ADMIN_APPLICATION_MODEL, 'minimax', 'the authenticated operator choice reaches the worker authorization boundary');
    assert.equal(state.starts.at(-1)[1].APPLICATION_REVIEW_MODE, 'prepare', 'changing provider never grants final submission approval');
    const applicationBudget={baseUsd:2,maximumUsd:4};
    assert.deepEqual(await startRun({...request,oneTime:{applicationBudget}}),{ok:true,mode:'live'});
    assert.equal(state.starts.at(-1)[1].OPERATOR_APPLICATION_BASE_USD,'2');
    assert.equal(state.starts.at(-1)[1].OPERATOR_APPLICATION_MAXIMUM_USD,'4');
    assert.equal(state.starts.at(-1)[1].APPLICATION_REVIEW_MODE,'prepare','spending authorization cannot authorize submission');
    const budgetAudit=state.queries.findLast((entry:{sql:string;params:unknown[]})=>entry.sql.includes('UPDATE run_starts SET operator_options'));
    assert.deepEqual(JSON.parse(budgetAudit.params[2] as string),{applicationBudget});
    for(const applicationBudget of [{baseUsd:0,maximumUsd:4},{baseUsd:4,maximumUsd:2},{baseUsd:2,maximumUsd:11},{baseUsd:NaN,maximumUsd:4}]) {
      assert.equal((await startRun({...request,oneTime:{applicationBudget}}) as {status:number}).status,400);
    }
    assert.equal((await startRun({...request,trigger:'manual',oneTime:{applicationBudget}}) as {status:number}).status,403);
    assert.deepEqual(await startRun(request),{ok:true,mode:'live'});
    assert.equal(state.starts.at(-1)[1].OPERATOR_APPLICATION_BASE_USD,undefined,'the next ordinary run has no spending override');
    const indeedId='abc123def4567890';
    state.events=[{job_id:indeedId,title:'Recorded analyst',company:'Recorded employer',url:`https://au.indeed.com/viewjob?jk=${indeedId}`}];
    assert.deepEqual(await startRun({...request,jobIds:[indeedId]}),{ok:true,mode:'live'});
    const exactIndeed=state.starts.at(-1)[1];
    assert.deepEqual(JSON.parse(exactIndeed.TARGET_INDEED_JOBS),[{job_id:indeedId,title:'Recorded analyst',company:'Recorded employer'}]);
    assert.equal(exactIndeed.TARGET_SEEK_JOBS,'[]');assert.equal(exactIndeed.PLATFORMS,'indeed');
    assert.equal(exactIndeed.APPLICATION_REVIEW_MODE,'prepare','an Indeed target cannot authorize a Semi auto send');
    assert.equal(exactIndeed.MIN_SCORE,'70');assert.equal(exactIndeed.MAX_AGE_DAYS,'15');
    assert.equal((await startRun({...request,jobIds:[id,indeedId]}) as {status:number}).status,400);
    state.events=[];
    const beforeMissingIndeed=state.starts.length;
    assert.equal((await startRun({...request,jobIds:[indeedId]}) as {status:number}).status,400);
    assert.equal(state.starts.length,beforeMissingIndeed,'an unrecorded Indeed job cannot fall back to discovery');
    const starts = state.starts.length;
    assert.equal((await startRun({ ...request, oneTime: { includeSavedChoices: 'false' as unknown as boolean } }) as { status: number }).status, 400);
    assert.equal((await startRun({ ...request, trigger: 'manual', oneTime: { includeSavedChoices: false } }) as { status: number }).status, 403);
    assert.equal(state.starts.length, starts, 'invalid or unauthorized selection overrides cannot start a worker');
    state.credits = 0;
    assert.equal((await startRun(request) as { status: number }).status, 402, 'retained metadata does not bypass billing allowance');
    state.credits = 5; state.sent = 100;
    assert.equal((await startRun(request) as { status: number }).status, 429, 'retained metadata does not bypass the daily cap');
    state.sent = 0; state.busy = true;
    assert.equal((await startRun(request) as { status: number }).status, 409, 'an existing account run retains its claim');
    state.busy = false;
    assert.equal((await startRun({ ...request, approvals: [{ id: 'not-approved' }] }) as { status: number }).status, 400, 'Semi auto targeting cannot become an approved send');
    writeFileSync(alias, '{corrupt');
    assert.equal((await startRun(request) as { status: number }).status, 400);
    assert.equal(state.starts.length, starts, 'refused starts never launch a process');
    state.credits=0;
    const sponsored={...request,jobIds:undefined,scope:undefined,applicationMode:'auto' as const,
      oneTime:{plan:'intensive-pass' as const,maxApplications:50,maxEvaluations:400,seedSeekJobs:[{id:'95369588',title:'Principal Penetration Tester',company:'Fixture Employer',source:'chosen',fitReview:{score:100}}]}};
    assert.deepEqual(await startRun(sponsored),{ok:true,mode:'live'},'a sponsored run works without purchasing or granting a persistent pass');
    const launched=state.starts.at(-1);
    assert.equal(launched[1].MAX_EVALUATIONS,'400');assert.equal(launched[1].MAX_APPS_PER_RUN,'50');
    assert.equal(launched[1].MIN_SCORE,'70');assert.equal(launched[1].MAX_AGE_DAYS,'15');
    assert.equal(launched[1].OPERATOR_PLAN,'intensive-pass');assert.equal(launched[1].ALLOW_EXTERNAL_APPLY,'true');
    assert.equal(JSON.parse(launched[1].DISCOVERY_SEED_JOBS_JSON)[0].source,'search');
    assert.equal(JSON.parse(launched[1].DISCOVERY_SEED_JOBS_JSON)[0].fitReview,undefined,'a discovery lead carries no approval or fit waiver');
    assert.equal(launched[1].TARGET_SEEK_JOBS,undefined,'leads do not replace the ordinary discovery streams');
    assert.equal(launched[3],undefined,'complimentary applications must not install the credit-deduction callback');
    assert.equal(launched[4],undefined,'dashboard closures must not own application completion');
    assert.deepEqual(launched[7],{chargeSubmission:false,releaseProxy:true},'the worker service owns temporary route cleanup without charging complimentary applications');
    const audit=state.queries.findLast((entry:{sql:string})=>entry.sql.includes('UPDATE run_starts SET operator_options'));
    assert.equal(JSON.parse(audit.params[2]).maxEvaluations,400);
    assert.ok(state.queries.every((entry:{sql:string})=>!/(INSERT|UPDATE|DELETE).*?(billing|settings|credit_grants)/i.test(entry.sql)), 'no saved preference or plan mutation');
    assert.equal((await startRun({...request,jobIds:undefined}) as {status:number}).status,402,'the next ordinary run still has its real allowance');
    state.credits=5;
    state.repairs=[{id:attemptId,revision:'a'.repeat(64),retry:true,sourceRunId:'1145'}];
    state.approvedDrafts=[{id:attemptId,revision:'a'.repeat(64),job:{id,title:metadata.title,company:metadata.company,platform:'seek',location:'Sydney',url:trace.job.url},formUrl:trace.job.url,answers:[],resumeId:'fixture-resume'}];
    const repairRequest={userId:'183',email:'candidate@fixture.invalid',trigger:'admin' as const,startedBy:'1',mode:'live' as const,applicationMode:'semi-auto' as const,repairPriorRuns:true};
    assert.deepEqual(await startRun(repairRequest),{ok:true,mode:'live',priorRunRepair:{count:1,sourceRunIds:['1145']}});
    const repaired=state.starts.at(-1)[1];
    assert.equal(repaired.APPLICATION_REVIEW_MODE,'approved');assert.equal(repaired.PRIOR_RUN_REPAIR_COUNT,'1');
    assert.equal(JSON.parse(repaired.APPROVED_APPLICATIONS_JSON)[0].revision,'a'.repeat(64),'the exact old approval is reused, never rewritten');
    assert.equal((await startRun({...repairRequest,trigger:'manual'}) as {status:number}).status,403);
    assert.equal((await startRun({...repairRequest,jobIds:[id]}) as {status:number}).status,400);
    state.repairs=[];const beforeEmptyRepair=state.starts.length;
    assert.equal((await startRun({...repairRequest,requirePriorRunRepair:true}) as {status:number}).status,409);
    assert.equal(state.starts.length,beforeEmptyRepair,'an explicit repair-only request cannot fall through to discovery');
    assert.ok(state.queries.every((entry:{sql:string})=>!/(INSERT|UPDATE|DELETE).*?(billing|settings|credit_grants)/i.test(entry.sql)));
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    rmSync(directory, { recursive: true, force: true });
  }
});
