import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { AppliedRecord, BlockedQuestion, JobListing } from './types.js';
import type { TechnicalRetryCandidate } from './technical-retry-types.js';
import { sealQuestionSnapshot } from './question-snapshot-node.js';

type FixtureJob = JobListing & { reviewPriority?: number; searchPage?: number; searchScope?: 'office' | 'remote' | 'unscoped'; detailApplicationMode?: 'hosted' | 'external'; detailDescription?: string; cardConflict?: boolean; wall?: boolean; searchOnlyJob?: boolean; detailApplied?: boolean; loadingFirst?: boolean; fitError?: boolean; fitReject?: boolean; matchScore?: number; lateApplied?: boolean; delayMs?: number; detailDelayMs?: number; detailWaitFor?: { stage: string; id: string }; applyWaitFor?: { stage: string; id: string }; fitDelayMs?: number; detailError?: boolean; formUrl?: string; uncertain?: boolean; preSendFailure?: boolean };
const job = (id: string, extra: Partial<FixtureJob> = {}): FixtureJob => ({
  id, title: `Developer ${id}`, company: 'Fixture Employer', location: 'Sydney', ageDays: 1,
  url: `https://fixture.invalid/job/${id}`, platform: 'seek', applicationMode: 'hosted', ...extra,
});

/** Exercise the compiled main loop with offline boundary adapters, real history
 * and a one-review budget. No browser, model or employer is contacted. */
function run(jobs: FixtureJob[], options: { targetedIds?:string[]; scope?: 'all' | 'external' | 'hosted'; waiting?: Array<{ job: FixtureJob; questions: BlockedQuestion[] }>; savedAnswers?: unknown[]; attentionOnFit?: { job: FixtureJob; questions: BlockedQuestion[] }; repairTarget?: FixtureJob; priorReviews?: Array<{ job: FixtureJob; description?: string; changedContext?: boolean }>; completed?: Array<{job:FixtureJob;decision:'apply'|'skip'|'uncertain'}>; retries?:TechnicalRetryCandidate[]; prepare?: boolean; approvedIds?: string[]; pendingKeys?: string[]; externalLimit?: number; instructions?: string; history?: AppliedRecord[]; apply?: boolean; queue?: boolean; platform?: 'seek' | 'indeed'; concurrency?: number; workers?: number; cap?: number; reviews?: number; failedParallelSignin?: boolean; cooldownMs?: number; dailyCap?: number; minScore?: number; maxAgeDays?: number; excludedCompanies?: string[]; workArrangements?: string[]; onsiteCity?: string; platforms?: string[] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-review-budget-'));
  const url = (file: string) => pathToFileURL(join(directory, file)).href;
  try {
    writeFileSync(join(directory, 'profile.txt'), 'Full name: Fixture Candidate\n');
    writeFileSync(join(directory, 'applied.json'), JSON.stringify(options.history ?? []));
    writeFileSync(join(directory, 'jobs.json'), JSON.stringify(jobs));
    writeFileSync(join(directory, 'events.jsonl'), '');
    const attention = (items: NonNullable<typeof options.waiting>) => ({ asOf: new Date().toISOString(), items: items.map(({ job: item, questions }) => ({
      jobId: item.id, title: item.title, company: item.company, url: item.url, at: new Date().toISOString(), reason: 'Exact required candidate question remains unanswered.', questions,
    })) });
    writeFileSync(join(directory, 'attention.json'), JSON.stringify(attention(options.waiting ?? [])));
    writeFileSync(join(directory, 'answers.json'), JSON.stringify(options.savedAnswers ?? []));
    writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify(jobs.filter(item => options.approvedIds?.includes(item.id)).map(item => ({ job: item }))));
    writeFileSync(join(directory, 'pending-application-keys.json'), JSON.stringify(options.pendingKeys ?? []));
    writeFileSync(join(directory, 'boundary.mjs'), `
import { readFileSync, appendFileSync } from 'node:fs';
export const jobs = JSON.parse(readFileSync(new URL('./jobs.json', import.meta.url)));
export const record = (stage, id, extra={}) => appendFileSync(new URL('./events.jsonl', import.meta.url), JSON.stringify({stage,id,at:Date.now(),...extra})+'\\n');
export const waitForEvent = async ({stage,id}) => {
  const deadline=Date.now()+3000;
  while(!readFileSync(new URL('./events.jsonl', import.meta.url),'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line)).some(event=>event.stage===stage && event.id===id)) {
    if(Date.now()>=deadline) throw Error('Fixture event was not observed: '+stage+'/'+id);
    await new Promise(done=>setTimeout(done,5));
  }
};
`);
    writeFileSync(join(directory, 'config.mjs'), `
export * from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
import { config } from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
Object.assign(config, {keywords:['fixture'],platforms:${JSON.stringify(options.platforms ?? (options.workers === 2 ? ['seek', 'indeed'] : [options.platform ?? 'seek']))},aiInstructions:${JSON.stringify(options.instructions ?? '')},allowExternalApply:${options.externalLimit !== 0}});
Object.assign(config.coverLetter, {mode:'tailored'});
Object.assign(config.rules, {minScore:${options.minScore ?? 0},maxAgeDays:${options.maxAgeDays ?? 20},workArrangements:${JSON.stringify(options.workArrangements ?? ['onsite'])},onsiteCity:${JSON.stringify(options.onsiteCity ?? 'Sydney')}});
Object.assign(config.search, {location:'',radiusKm:0});
config.excludedCompanies = ${JSON.stringify(options.excludedCompanies ?? [])};
Object.assign(config.limits, {maxEvaluations:${options.reviews ?? 1},fitConcurrency:${options.concurrency ?? 1},maxApplicationsPerRun:${options.cap ?? 1},maxApplicationsPerDay:${options.dailyCap ?? 100},maxExternalPerDay:${options.externalLimit ?? 10},
  minDelayMs:${options.cooldownMs ?? 0},maxDelayMs:${options.cooldownMs ?? 0},minNonSubmitDelayMs:0,maxNonSubmitDelayMs:0,searchDelayMs:0});
`);
    writeFileSync(join(directory, 'discovery.mjs'), `
import { jobs, record, waitForEvent } from './boundary.mjs';
const reads = new Map();
const platform = new URL(import.meta.url).searchParams.get('platform');
export const search = async (_page,_keyword,pageNumber,scope) => {
  record('search',platform,{page:_page.worker,pageNumber,scope});
  _page.currentJob='search:'+platform;
  await new Promise(done=>setTimeout(done,10));
  if(_page.currentJob!=='search:'+platform) throw Error('Discovery page was navigated by another worker');
  const searchScope=scope ? scope.arrangements.every(value=>value==='remote')?'remote':'office' : 'unscoped';
  return jobs.filter(job=>job.platform===platform && (job.searchPage??1)===pageNumber && (!job.searchScope || job.searchScope===searchScope));
};
export const fetchJobDetail = async (_page, job) => {
  job={...job,...jobs.find(value=>value.id===job.id && value.platform===job.platform)};
  record('detail',job.id,{page:_page.worker});
  _page.currentJob=job.id;
  await new Promise(done=>setTimeout(done,job.detailDelayMs||0));
  if(job.detailWaitFor) await waitForEvent(job.detailWaitFor);
  if(_page.currentJob!==job.id) throw Error('Another reviewer navigated this page');
  if(job.wall) throw Error('VerificationBlocked: Fixture security verification');
  if(job.detailError) throw Error('Fixture unavailable listing');
  record('detail-finish',job.id,{page:_page.worker});
  const count = (reads.get(job.id) || 0) + 1; reads.set(job.id,count);
  if(job.loadingFirst && count === 1) return {...job,description:'',alreadyApplied:false};
  return {...job,applicationMode:job.detailApplicationMode??job.applicationMode,description:job.detailDescription??'Build software in Sydney.',alreadyApplied:job.detailApplied===true,appliedNote:'You applied on 1 October'};
};
`);
    writeFileSync(join(directory, 'feeds.mjs'), `
export class EmployerFeedDiscovery {
  constructor(source) { this.source=source; }
  async search(keyword,page) {
    const {search}=await import('./discovery.mjs?platform='+this.source);
    return search({worker:'feed-'+this.source},keyword,page);
  }
  async detail(job) {
    const {fetchJobDetail}=await import('./discovery.mjs?platform='+this.source);
    return fetchJobDetail({worker:'feed-'+this.source},job);
  }
}
export class SmartRecruitersDiscovery extends EmployerFeedDiscovery {
  constructor(){super('smartrecruiters');}
}
`);
    writeFileSync(join(directory, 'browser.mjs'), `
import { record } from './boundary.mjs';
import { currentApplicationWorker } from ${JSON.stringify(new URL('./application-workers.js', import.meta.url).href)};
export const launchBrowser = async () => ({});
export const applicationWorkerContexts = async () => [0,1].map(worker => ({newPage:async()=>({worker,isClosed:()=>false}),close:async()=>{}}));
export const getPage = async () => ({worker:'discovery',isClosed:()=>false});
export const closeBrowser = async () => {};
export const ensureSignedIn = async page => {if(${options.failedParallelSignin === true} && typeof page.worker === 'number') throw Error('Fixture isolated session expired');};
export const ensureIndeedSignedIn = async () => {};
export const workingIn = async () => {};
export const showLiveActivity = async (activity,page) => { record('activity-'+activity.phase,currentApplicationWorker(),{page:page?.worker}); };
export const jitter = async () => {};
`);
    writeFileSync(join(directory, 'llm.mjs'), `
import { record } from './boundary.mjs';
export const reviewKey = job => job.platform+':'+job.id;
export const rankJobsForReview = async jobs => new Map(jobs.map(job => [reviewKey(job),{priority:job.reviewPriority??90,reason:'Fixture priority'}]));
export const finishedCoverLetterForJob = async () => 'Fixture letter';
import { config } from './config.mjs';
import {completedReview} from ${JSON.stringify(new URL('./completed-reviews.js',import.meta.url).href)};
export const assessFit = async job => {
  const saved=completedReview(job);if(saved){record('fit-reused',job.id);return {...saved.assessment,reviewReused:true};}
  record('fit',job.id);
  const updatedAttention=${JSON.stringify(options.attentionOnFit ? attention([options.attentionOnFit]) : null)};
  if(updatedAttention && job.id===updatedAttention.items[0].jobId) {
    const {writeFileSync}=await import('node:fs');writeFileSync(new URL('./attention.json',import.meta.url),JSON.stringify(updatedAttention));
  }
  await new Promise(done => setTimeout(done,job.fitDelayMs||0));
  record('fit-finish',job.id);
  if(job.fitError) { await new Promise(done => setTimeout(done,20)); throw Error('The matching agent did not return a usable decision after a format retry.'); }
  const rejected = job.fitReject || job.cardConflict || (job.matchScore??90)<config.rules.minScore;
  return {decision:rejected?'skip':'apply',shouldApply:!rejected,matchScore:job.matchScore??90,reason:'Fixture fit',evidence:['Fixture'],injectionSuspected:false};
};
`);
    writeFileSync(join(directory, 'apply.mjs'), `
import { record, waitForEvent } from './boundary.mjs';
import { applicationAllowance } from ${JSON.stringify(new URL('./application-allowance.js', import.meta.url).href)};
import {approvedApplication} from ${JSON.stringify(new URL('./application-review.js',import.meta.url).href)};
import { isExternalApplicationUrl } from ${JSON.stringify(new URL('./job-board-url.js', import.meta.url).href)};
const performFixtureWork = async (_page,job) => {
  const approved=approvedApplication(job);
  record('apply',job.id,{approval:approved??null});
  if(job.applyWaitFor) await waitForEvent(job.applyWaitFor);
  await new Promise(done=>setTimeout(done,job.delayMs||0));
  if(job.preSendFailure) return {status:'error',jobId:job.id,error:'Fixture failure before send'};
  if(job.formUrl && !(await applicationAllowance(isExternalApplicationUrl(job.formUrl)))) { record('denied',job.id); return {status:'needs-human',jobId:job.id,reason:'Application allowance unavailable'}; }
  record('finish',job.id);
  if(process.env.APPLICATION_REVIEW_MODE === 'prepare') return {status:'prepared',jobId:job.id,draft:{job}};
  if(job.uncertain) return {status:'error',jobId:job.id,error:'Fixture uncertain response',submitPressed:true};
  return job.lateApplied ? {status:'already-applied',jobId:job.id,reason:'Already recorded by the employer'}
    : {status:'applied',jobId:job.id,at:new Date().toISOString()};
};
export const applyToJobWithAgent = async (...args) => {record('form-fill',args[1].id);return performFixtureWork(...args);};
export const prepareMatchedJob = async (job) => {record('prepare-only',job.id);return performFixtureWork(undefined,job);};
export const applyToIndeedJob = applyToJobWithAgent;
export const applyToEmployerJob = applyToJobWithAgent;
`);
    writeFileSync(join(directory, 'blocker.mjs'), "export const WALL_STATES = new Set(['captcha','login','identity']); export const judgePage = async () => ({state:'loading',reason:'Fixture delayed listing'});");
    writeFileSync(join(directory,'retry.mjs'),`
import {record} from './boundary.mjs';
import {applicationKeys} from ${JSON.stringify(new URL('./application-identity.js',import.meta.url).href)};
const enabled=${Boolean(options.apply&&!options.prepare&&!options.approvedIds)};
const retries=${JSON.stringify(options.retries??[])};
export const deferredTechnicalRetryKeys=()=>new Set(enabled?retries.flatMap(row=>applicationKeys(row.job)):[]);
export const claimTechnicalRetryFallback=async shortfall=>{if(!enabled||!retries.length)return [];record('retry-fallback','batch',{shortfall});return retries.slice(0,shortfall);};
`);
    const overrides: Record<string, string> = {
      './config.js': 'config.mjs', './browser.js': 'browser.mjs', './llm.js': 'llm.mjs', './technical-retry-client.js':'retry.mjs',
      './discovery.js': 'discovery.mjs', './discovery-indeed.js': 'discovery.mjs',
      './employer-feeds.js':'feeds.mjs', './smartrecruiters.js':'feeds.mjs', './agent/apply-employer-job.js':'apply.mjs',
      './agent/apply-agent.js': 'apply.mjs', './apply-indeed.js': 'apply.mjs', './prepare-job.js':'apply.mjs', './blocker.js': 'blocker.mjs',
    };
    const main = readFileSync(new URL(options.queue ? './queue.js' : './main.js', import.meta.url), 'utf8').replace(
      /from ['"](\.\.?\/[^'"]+)['"]/g,
      (_match, specifier: string) => `from ${JSON.stringify(overrides[specifier] ? url(overrides[specifier]) + (specifier === './discovery.js' ? '?platform=seek' : specifier === './discovery-indeed.js' ? '?platform=indeed' : '') : new URL(specifier, import.meta.url).href)}`,
    );
    writeFileSync(join(directory, 'main.mjs'), main);
    writeFileSync(join(directory, 'start.mjs'), `
globalThis.fetch=async()=>{throw Error('HTTP is forbidden by this offline fixture');};
import {writeFileSync} from 'node:fs';
const {loadProfile}=await import('./config.mjs');
const {reviewCacheMetadata,reviewContextFingerprint}=await import(${JSON.stringify(new URL('./review-cache.js', import.meta.url).href)});
const context=reviewContextFingerprint(loadProfile());
const {rememberCompletedReview}=await import(${JSON.stringify(new URL('./completed-reviews.js',import.meta.url).href)});
for(const item of ${JSON.stringify(options.completed ?? [])})rememberCompletedReview(item.job,{decision:item.decision,shouldApply:item.decision==='apply',matchScore:90,reason:'Prior completed fit',evidence:['Fixture'],injectionSuspected:false});
const priors=${JSON.stringify(options.priorReviews ?? [])};
writeFileSync(new URL('./review-cache.jsonl',import.meta.url),priors.map(prior=>JSON.stringify({
  ...reviewCacheMetadata({...prior.job,description:prior.description??'Build software in Sydney.'},'fit-mismatch',prior.changedContext?'old-context':context,null),
  jobId:prior.job.id,title:prior.job.title,company:prior.job.company,reason:'Prior rejection',reviewedAt:'2026-01-01T00:00:00Z'
})).join('\\n'));
${options.queue ? "process.argv[1]='queue.js';" : ''} await import('./main.mjs');`);
    const output = execFileSync(process.execPath, [join(directory, 'start.mjs'), ...(options.apply ? [] : ['--search-only'])], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, DATA_DIR: directory, PROFILE_PATH: join(directory, 'profile.txt'),
        CELERIS_API_KEY: 'fixture-only', COVER_LETTER_MODE: 'tailored',
        APPLICATION_REVIEW_MODE: options.prepare ? 'prepare' : options.approvedIds ? 'approved' : '', APPLY_ONLY: options.scope ?? 'all',
        APPLICATION_WORKERS: String(options.workers ?? 1), DIRECT_EXTERNAL_JOB_URL: '', TARGETED_JOBS_JSON: '', TARGET_SEEK_JOBS: JSON.stringify(jobs.filter(item=>options.platform!=='indeed'&&options.targetedIds?.includes(item.id)).map(item=>({job_id:item.id,title:item.title,company:item.company}))), TARGET_INDEED_JOBS:JSON.stringify(jobs.filter(item=>options.platform==='indeed'&&options.targetedIds?.includes(item.id)).map(item=>({job_id:item.id,title:item.title,company:item.company}))), OWTOMATE_REPAIR_CASE_ID: options.repairTarget ? 'fixture-repair' : '', TARGET_REPAIR_JOB_JSON: options.repairTarget ? JSON.stringify(options.repairTarget) : '', EMPLOYER_FEEDS_ADMIN_ENABLED: options.platforms?.some(id => !['seek', 'indeed'].includes(id)) ? 'true' : 'false', SMARTRECRUITERS_ADMIN_ENABLED: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const events = readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const history: AppliedRecord[] = JSON.parse(readFileSync(join(directory, 'applied.json'), 'utf8'));
    return { output, events, history, attention: JSON.parse(readFileSync(join(directory, 'attention.json'), 'utf8')) };
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-review-budget-'));
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const prepare of [false, true]) test(`${prepare ? 'Semi auto':'Auto apply'} starts its first ready job without collecting a full discovery buffer`, () => {
  const result=run(Array.from({length:25},(_,i)=>job(`page-${i+1}`,{searchPage:i+1})),{apply:true,prepare,reviews:200,cap:1});
  assert.deepEqual(result.events.filter(e=>e.stage==='search').map(e=>e.pageNumber),[1]);
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['page-1']);
  assert.equal(result.history.length,prepare?0:1);
});

test('an unsuitable first batch resumes discovery but does not delay the next ready application for later pages', () => {
  const result=run([job('rejected',{fitReject:true}),job('next-match',{searchPage:2}),job('unneeded',{searchPage:3})],{apply:true,reviews:200,cap:1});
  assert.deepEqual(result.events.filter(e=>e.stage==='search').map(e=>e.pageNumber),[1,2]);
  assert.deepEqual(result.events.filter(e=>e.stage==='fit').map(e=>e.id),['rejected','next-match']);
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['next-match']);
});

for (const prepare of [false,true]) test(`${prepare?'Semi auto':'Auto apply'} never searches employer feeds when SEEK and Indeed fill the application target`, () => {
  const result=run([job('seek-match'),job('indeed-match',{platform:'indeed'}),job('unneeded-feed',{platform:'pageup',applicationMode:'external'})],
    {apply:true,prepare,platforms:['pageup','indeed','seek'],reviews:200,cap:2});
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['seek-match','indeed-match']);
  assert.equal(result.events.some(e=>e.stage==='search'&&e.id==='pageup'),false);
  assert.doesNotMatch(result.output,/PageUp public job feed ready/,'the activity panel must not claim to search an unused fallback');
});

test('hosted-board pagination gets its chance before the first employer-feed search', () => {
  const result=run([job('seek-rejection',{fitReject:true}),job('indeed-rejection',{platform:'indeed',fitReject:true}),
    job('later-hosted-match',{searchPage:2}),job('unneeded-feed',{platform:'pageup',applicationMode:'external'})],
    {apply:true,platforms:['seek','indeed','pageup'],reviews:200,cap:1});
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['later-hosted-match']);
  assert.equal(result.events.some(e=>e.stage==='search'&&e.id==='pageup'),false);
});

test('an idle parallel worker does not search employer feeds while hosted applications can fill the target', () => {
  const result=run([job('hosted-one',{delayMs:80}),job('hosted-two',{delayMs:80}),
    job('unneeded-feed',{platform:'pageup',applicationMode:'external'})],
    {apply:true,workers:2,platforms:['seek','indeed','pageup'],reviews:200,cap:2});
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['hosted-one','hosted-two']);
  assert.equal(result.events.some(e=>e.stage==='search'&&e.id==='pageup'),false);
});

test('employer feeds fill the remaining shortfall after hosted results and then apply before unrelated feed reviews', () => {
  const result=run([job('seek-rejection',{fitReject:true}),job('indeed-match',{platform:'indeed'}),
    job('feed-match',{platform:'pageup',applicationMode:'external',reviewPriority:100}),
    ...Array.from({length:8},(_,i)=>job(`other-feed-review-${i}`,{platform:'pageup',applicationMode:'external',reviewPriority:80,fitReject:true})),
  ],{apply:true,platforms:['pageup','seek','indeed'],reviews:200,cap:2});
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['indeed-match','feed-match']);
  const feedSearch=result.events.findIndex(e=>e.stage==='search'&&e.id==='pageup');
  assert.ok(feedSearch>result.events.findIndex(e=>e.stage==='finish'&&e.id==='indeed-match'));
  assert.ok(result.events.filter(e=>e.stage==='search'&&['seek','indeed'].includes(e.id)).every(e=>result.events.indexOf(e)<feedSearch));
  assert.equal(result.events.some(e=>e.stage==='detail'&&e.id.startsWith('other-feed-review')),false,'a ready employer match must not wait for the entire feed review queue');
  assert.equal(result.history.length,2);
});

test('a worker with weak listings waits for the hosted attempt, then resumes employer discovery without spinning', () => {
  const result=run([job('hosted-match',{delayMs:80}),job('weak-board-result',{platform:'indeed',reviewPriority:10,fitReject:true}),
    job('feed-shortfall',{platform:'pageup',applicationMode:'external'})],
    {apply:true,workers:2,platforms:['seek','indeed','pageup'],reviews:200,cap:2});
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['hosted-match','feed-shortfall']);
  assert.ok(result.events.findIndex(e=>e.stage==='search'&&e.id==='pageup')>result.events.findIndex(e=>e.stage==='finish'&&e.id==='hosted-match'));
  assert.equal(result.events.some(e=>e.stage==='fit'&&e.id==='weak-board-result'),false);
});

test('a ready SEEK employer form waits for a later hosted match while preserving independent search pagination', () => {
  const result=run([job('employer-form',{applicationMode:'external',reviewPriority:100}),
    job('hosted-next-page',{searchPage:2,reviewPriority:80}),job('unneeded-feed',{platform:'pageup',applicationMode:'external'})],
    {apply:true,platforms:['pageup','seek'],reviews:200,cap:1});
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['hosted-next-page']);
  assert.deepEqual(result.events.filter(e=>e.stage==='search'&&e.id==='seek').map(e=>e.pageNumber),[1,2]);
  assert.equal(result.events.some(e=>e.stage==='search'&&e.id==='pageup'),false);
});

for(const prepare of [false,true])test(`${prepare?'Semi auto':'Auto apply'} prioritizes confirmed hosted forms over unknown redirects in the same batch`,()=>{
  const result=run([job('unknown-redirect',{applicationMode:'unknown',reviewPriority:100}),
    job('confirmed-hosted',{reviewPriority:80})],{apply:true,prepare,reviews:200,cap:1});
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['confirmed-hosted']);
  assert.equal(result.events.some(e=>e.stage==='detail'&&e.id==='unknown-redirect'),false);
});

test('an unknown application link stays available as fallback after hosted-board search has run out',()=>{
  const result=run([job('unknown-fallback',{applicationMode:'unknown',reviewPriority:100}),
    job('unneeded-feed',{platform:'pageup',applicationMode:'external'})],{apply:true,platforms:['seek','pageup'],reviews:200,cap:1});
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['unknown-fallback']);
  const applyAt=result.events.findIndex(e=>e.stage==='apply');
  assert.ok(result.events.some((e,i)=>e.stage==='search'&&e.id==='seek'&&e.pageNumber===2&&i<applyAt));
  assert.equal(result.events.some(e=>e.stage==='search'&&e.id==='pageup'),false,'known board leads are tried before collecting additional employer feeds');
});

test('an unavailable board cannot prevent the employer-source fallback from submitting a matching job', () => {
  const result=run([job('board-wall',{wall:true}),job('feed-backup',{platform:'pageup',applicationMode:'external'})],
    {apply:true,platforms:['seek','pageup'],reviews:200,cap:1});
  assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),['feed-backup']);
  assert.equal(result.history.length,1);
});

test('operator discovery leads recheck the live employer, age and fit while ordinary discovery continues',()=>{
  const previous=process.env.DISCOVERY_SEED_JOBS_JSON;
  const ids=['95369588','95369589','95369590'];
  process.env.DISCOVERY_SEED_JOBS_JSON=JSON.stringify(ids.map(id=>({id,title:'Security Engineer',company:'Initial search card',source:'chosen',fitReview:{score:100}})));
  try {
    const result=run([
      job(ids[0],{company:'Excluded Employer',searchPage:99}),
      job(ids[1],{ageDays:30,searchPage:99}),
      job(ids[2],{fitReject:true,searchPage:99}),
      job('ordinary-search-result',{reviewPriority:80}),
    ],{apply:true,reviews:2,cap:1,excludedCompanies:['Excluded Employer']});
    assert.deepEqual(result.events.filter(event=>event.stage==='fit').map(event=>event.id),[ids[2],'ordinary-search-result']);
    assert.deepEqual(result.events.filter(event=>event.stage==='apply').map(event=>event.id),['ordinary-search-result']);
    assert.ok(result.events.some(event=>event.stage==='search'),'a lead list must not disable normal keyword search');
    for(const id of ids)assert.ok(result.events.some(event=>event.stage==='detail'&&event.id===id),'every lead gets live listing evidence');
  }finally{if(previous===undefined)delete process.env.DISCOVERY_SEED_JOBS_JSON;else process.env.DISCOVERY_SEED_JOBS_JSON=previous;}
});

const requiredAnswerSnapshot = (options = ['Yes', 'No']) => sealQuestionSnapshot({ version: 2,
  source: { origin: 'https://employer.fixture.invalid', path: '' }, prompt: 'Do you hold the required current licence?', context: [], help: [], completeness: 'complete',
  controls: [{ id: 'part0', label: 'Do you hold the required current licence?', kind: 'checkbox-group', required: true, multiple: true,
    choices: options.map((label, index) => ({ id: `choice${index}`, label, value: label, disabled: false })), constraints: {} }],
});
test('admin repair targeted retry re-inspects an old question with the same completed match and no invented answer',()=>{
 const target=job('98765432'),snapshot=requiredAnswerSnapshot();
 const result=run([target],{apply:true,targetedIds:[target.id],completed:[{job:target,decision:'apply'}],waiting:[{job:target,questions:[{question:snapshot.prompt,snapshot}]}]});
 assert.deepEqual(result.events.filter(event=>event.stage==='apply').map(event=>event.id),[target.id]);
 assert.equal(result.events.some(event=>event.stage==='fit'),false,'the completed matching decision is reused');
 assert.equal(result.attention.items.length,1,'the prior question is neither answered nor dismissed by a retry request');
 assert.equal(result.attention.items[0].questions[0].question,snapshot.prompt);
});
test('admin repair exact Indeed retry opens only its recorded posting and reuses the completed match',()=>{
 const target=job('abc123def4567890',{platform:'indeed',url:'https://au.indeed.com/viewjob?jk=abc123def4567890'});
 const extra=job('0000000000000000',{platform:'indeed'});
 const result=run([target,extra],{platform:'indeed',apply:true,targetedIds:[target.id],completed:[{job:target,decision:'apply'}]});
 assert.deepEqual(result.events.filter(event=>event.stage==='apply').map(event=>event.id),[target.id]);
 assert.equal(result.events.some(event=>event.stage==='fit'),false);
 assert.equal(result.events.some(event=>event.stage==='detail'&&event.id===extra.id),false,'no broad search or other posting can replace the exact retry');
});
for (const prepare of [false, true]) test(`${prepare ? 'Semi auto' : 'Auto apply'} external-only reviews semantic priority before scope certainty`, () => {
  const knownLow = job('known-external-low', { applicationMode: 'external', reviewPriority: 10 });
  const unknownHigh = job('unknown-high', { applicationMode: 'unknown', detailApplicationMode: 'external', reviewPriority: 78 });
  const result = run([knownLow, unknownHigh], { apply: true, prepare, scope: 'external', reviews: 1, cap: 1 });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), [unknownHigh.id]);
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), [unknownHigh.id]);
  assert.equal(result.events.some(event => event.stage === 'detail' && event.id === knownLow.id), false, 'a low-priority known destination cannot take the only review first');
});
test('an unknown card that resolves hosted does not spend an external-only fit slot or bypass scope', () => {
  const unknown = job('unknown-resolves-hosted', { applicationMode: 'unknown', detailApplicationMode: 'hosted', reviewPriority: 78 });
  const knownHosted = job('known-hosted', { applicationMode: 'hosted', reviewPriority: 99 });
  const external = job('external-backup', { applicationMode: 'external', reviewPriority: 10 });
  const result = run([knownHosted, external, unknown], { apply: true, prepare: true, scope: 'external', reviews: 1, cap: 1 });
  assert.deepEqual(result.events.filter(event => event.stage === 'detail').map(event => event.id), [unknown.id, external.id]);
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), [external.id]);
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), [external.id]);
});
test('known in-scope certainty breaks a semantic priority tie without overriding higher priorities', () => {
  const unknown = job('unknown-tied', { applicationMode: 'unknown', detailApplicationMode: 'external', reviewPriority: 78 });
  const known = job('known-tied', { applicationMode: 'external', reviewPriority: 78 });
  const result = run([unknown, known], { apply: true, scope: 'external', reviews: 1, cap: 1 });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), [known.id]);
});
for (const prepare of [false, true]) test(`${prepare ? 'Semi auto' : 'Auto apply'} defers exact current unanswered questions before model review and application`, () => {
  const blocked = job('waiting'), fresh = job('different-job', { company: blocked.company, applicationUrl: 'https://employer.fixture.invalid/shared/apply' });
  const snapshot = requiredAnswerSnapshot();
  const result = run([blocked, fresh], { apply: true, prepare, waiting: [{ job: blocked, questions: [{ question: snapshot.prompt, snapshot }] }] });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), [prepare?blocked.id:fresh.id]);
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), [prepare?blocked.id:fresh.id]);
  if(!prepare)assert.match(result.output, /waiting for your answers/);
});
test('an exact structured response reopens a pending job without deleting old ambiguous fragments', () => {
  const blocked = job('answered'), snapshot = requiredAnswerSnapshot();
  const result = run([blocked], { apply: true, prepare: true,
    waiting: [{ job: blocked, questions: [{ question: 'Yes' }, { question: snapshot.prompt, snapshot }] }],
    savedAnswers: [{ question: snapshot.prompt, answer: 'No', snapshot, response: { part0: ['choice1'] }, createdAt: new Date().toISOString() }],
  });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), [blocked.id]);
  assert.equal(result.attention.items[0].questions.length, 2, 'eligibility reads never erase question/audit history');
});
for (const prepare of [false, true]) test(`${prepare ? 'Semi auto' : 'Auto apply'} respects a complete current pending task without native required markup`, () => {
  const blocked = job('custom-validation'), fresh = job('fresh-after-custom-validation');
  const snapshot = sealQuestionSnapshot({ version: 2, source: { origin: 'https://employer.fixture.invalid', path: '' },
    prompt: 'Please describe your circumstances.', context: [], help: [], completeness: 'complete',
    controls: [{ id: 'part0', label: 'Please describe your circumstances.', kind: 'textarea', required: false, multiple: false, choices: [], constraints: {} }],
  });
  const waiting = [{ job: blocked, questions: [{ question: snapshot.prompt, snapshot }] }];
  const held = run([blocked, fresh], { apply: true, prepare, waiting });
  assert.deepEqual(held.events.filter(event => event.stage === 'fit').map(event => event.id), [prepare?blocked.id:fresh.id]);
  assert.deepEqual(held.events.filter(event => event.stage === 'apply').map(event => event.id), [prepare?blocked.id:fresh.id]);
  const reopened = run([blocked], { apply: true, prepare, waiting,
    savedAnswers: [{ question: snapshot.prompt, answer: 'Synthetic applicant response.', snapshot, response: { part0: 'Synthetic applicant response.' } }],
  });
  assert.deepEqual(reopened.events.filter(event => event.stage === 'apply').map(event => event.id), [blocked.id]);
});
test('changed question revisions cannot be released by an older structured answer', () => {
  const blocked = job('changed-question'), previous = requiredAnswerSnapshot(), current = requiredAnswerSnapshot(['Yes', 'No', 'Other']);
  const result = run([blocked, job('fresh-after-change')], { apply: true,
    waiting: [{ job: blocked, questions: [{ question: current.prompt, snapshot: current }] }],
    savedAnswers: [{ question: previous.prompt, answer: 'No', snapshot: previous, response: { part0: ['choice1'] } }],
  });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['fresh-after-change']);
});
test('legacy fragments and incomplete captures remain eligible for ordinary recapture', () => {
  for (const questions of [[{ question: 'Yes' }], [{ question: 'Month' }], [{ question: 'Current licence?', snapshot: sealQuestionSnapshot({ ...requiredAnswerSnapshot(), completeness: 'recapture' }) }]]) {
    const blocked = job('legacy');
    const result = run([blocked], { apply: true, prepare: true, waiting: [{ job: blocked, questions }] });
    assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), [blocked.id]);
  }
});
test('equal board IDs on a different source and different forms are not pending-question duplicates', () => {
  const original = job('same-id', { url: 'https://www.seek.com.au/job/12345678' });
  const other = job('same-id', { platform: 'indeed', url: 'https://www.indeed.com/viewjob?jk=fixture' });
  const snapshot = requiredAnswerSnapshot();
  const result = run([other], { apply: true, platform: 'indeed', waiting: [{ job: original, questions: [{ question: snapshot.prompt, snapshot }] }] });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), [other.id]);
});
for(const prepare of [false,true])test(`${prepare?'Preparation defers':'Auto apply rechecks'} a question arriving after matching`, () => {
  const target = job('late-question'), snapshot = requiredAnswerSnapshot();
  const result = run([target], { apply: true, prepare, attentionOnFit: { job: target, questions: [{ question: snapshot.prompt, snapshot }] } });
  assert.ok(result.events.some(event => event.stage === 'fit'));
  assert.equal(result.events.some(event => event.stage === 'apply'), prepare);
  assert.equal(result.events.some(event=>event.stage==='form-fill'),false);
});
test('the existing exact operator repair target may recapture a pending question without a new bypass', () => {
  const target = job('repair-waiting'), snapshot = requiredAnswerSnapshot();
  const result = run([target], { apply: true, prepare: true, repairTarget: target, waiting: [{ job: target, questions: [{ question: snapshot.prompt, snapshot }] }] });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), [target.id]);
});

for (const prepare of [false, true]) test(`${prepare ? 'Semi auto' : 'Auto apply'} applies the office match before continuing the independent nationwide remote search`, () => {
  const wrongCity = Array.from({ length: 15 }, (_, i) => job(`wrong-city-${i}`, { searchScope: 'unscoped', location: 'Brisbane QLD', cardConflict: true }));
  const result = run([...wrongCity,
    job('local-fit', { searchScope: 'office', location: 'Wollongong NSW', workArrangement: 'On-site' }),
    job('remote-fit', { searchScope: 'remote', location: 'Melbourne VIC', workArrangement: 'Remote' }),
  ], { apply: true, prepare, onsiteCity: 'Wollongong', workArrangements: ['onsite', 'hybrid', 'remote'], reviews: 15, cap: 2 });
  const searches = result.events.filter(event => event.stage === 'search');
  assert.deepEqual(searches.slice(0, 2).map(event => [event.scope.location, event.scope.arrangements]), [['Wollongong', ['onsite', 'hybrid']], ['', ['remote']]]);
  const firstApply = result.events.findIndex(event => event.stage === 'apply');
  assert.ok(firstApply < result.events.findIndex(event => event.stage === 'search' && event.scope.arrangements[0] === 'remote'), 'a ready local application starts without waiting for another search; the remote stream still gets its turn');
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['local-fit', 'remote-fit']);
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['local-fit', 'remote-fit']);
  assert.equal(result.history.length, prepare ? 0 : 2);
});

test('age-window discovery reaches fresh jobs beyond eight already-applied batches without a depth cap', () => {
  const old = Array.from({ length: 8 }, (_, index) => job(`applied-${index}`, { searchPage: index + 1 }));
  const fresh = job('new-ninth-batch', { searchPage: 9, ageDays: 20 });
  const result = run([...old, fresh], {
    apply: true, maxAgeDays: 20,
    history: old.map(item => ({ jobId: item.id, title: item.title, company: item.company, location: item.location, url: item.url,
      appliedAt: new Date().toISOString(), platform: 'seek', score: 0, scoreReasons: [], submittedByMyasis: false })),
  });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), [fresh.id]);
  assert.ok(result.events.some(event => event.stage === 'search' && event.pageNumber === 9));
  assert.ok(result.history.some(record => record.jobId === fresh.id && record.submittedByMyasis));
});

test('age-window policy matches undated jobs in Auto and Semi auto while excluding confirmed old jobs', () => {
  for (const prepare of [false, true]) {
    const result = run([job('unknown', { ageDays: undefined }), job('old', { ageDays: 21 }), job('in-range', { ageDays: 20 })], { apply: true, prepare, maxAgeDays: 20, cap: 2, reviews: 2 });
    assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['unknown', 'in-range']);
    assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['unknown', 'in-range']);
  }
});

test('admin repair targets exactly one original listing and retains fit and duplicate gates on both boards', () => {
  for (const platform of ['seek','indeed'] as const) for (const prepare of [false,true]) {
    const target=job('repair-original',{platform});
    const result=run([target,job('unrelated',{platform})],{apply:true,platform,prepare,repairTarget:target});
    assert.deepEqual(result.events.filter(e=>e.stage==='fit').map(e=>e.id),[target.id]);
    assert.deepEqual(result.events.filter(e=>e.stage==='apply').map(e=>e.id),[target.id]);
    assert.equal(result.events.some(e=>e.stage==='search'),false);
    const rejected=run([target],{apply:true,platform,prepare,repairTarget:{...target,fitReject:true}});
    assert.equal(rejected.events.some(e=>e.stage==='apply'),false);
    const duplicate=run([target],{apply:true,platform,prepare,repairTarget:{...target,detailApplied:true}});
    assert.equal(duplicate.events.some(e=>e.stage==='apply'),false);
  }
});

for (const prepare of [false, true]) test(`${prepare ? 'Semi auto' : 'Auto apply'} refills promising jobs before weak recommendations consume the remaining reviews`, () => {
  const result = run([
    ...Array.from({length: 12}, (_, i) => job(`promising-rejected-${i}`, {source: 'recommended', fitReject: true})),
    ...Array.from({length: 30}, (_, i) => job(`weak-recommendation-${i}`, {source: 'recommended', reviewPriority: 10, fitReject: true})),
    ...Array.from({length: 3}, (_, i) => job(`next-page-fit-${i}`, {searchPage: 2, source: 'search'})),
  ], {apply: true, prepare, reviews: 15, cap: 3});
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['next-page-fit-0', 'next-page-fit-1', 'next-page-fit-2']);
  assert.equal(result.events.filter(event => event.stage === 'fit').length, 15, 'refilling discovery does not increase the review allowance');
  assert.ok(!result.events.some(event => event.stage === 'fit' && event.id.startsWith('weak-recommendation')));
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, prepare ? 0 : 3);
});

test('Semi auto prepares only its run cap without entering the form-filling adapter or recording submissions', () => {
  const result = run([job('one'), job('two'), job('three')], { apply: true, prepare: true, cap: 2, reviews: 3 });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['one', 'two']);
  assert.deepEqual(result.events.filter(event => event.stage === 'prepare-only').map(event => event.id), ['one','two']);
  assert.equal(result.events.some(event=>event.stage==='form-fill'),false);
  assert.equal(result.history.length, 0);
  assert.match(result.output, /Semi auto complete: 2 application/);
});

for(const prepare of [true,false])test(`${prepare?'Semi auto':'Auto apply'} gives promising hosted work priority before using an employer-site fallback`,()=>{
  const external=job('ready-employer-site',{applicationMode:'external',reviewPriority:100});
  const later=job('later-hosted-rejection',{applicationMode:'hosted',reviewPriority:80,fitReject:true});
  const result=run([external,later],{apply:true,prepare,reviews:2,cap:1});
  assert.deepEqual(result.events.filter(event=>event.stage==='apply').map(event=>event.id),[external.id]);
  assert.equal(result.events.some(event=>event.stage==='detail'&&event.id===later.id),true,
    'the fallback starts once the promising hosted listing has been checked');
  assert.equal(result.events.some(event=>event.stage==='form-fill'),!prepare);
  assert.equal(result.history.filter(record=>record.submittedByMyasis).length,prepare?0:1);
});

test('old rejected recommendations cannot consume the only review before a fresh search result', () => {
  const old = job('old-rejection', { source: 'recommended' });
  const fresh = job('unseen-search', { searchOnlyJob: true, source: 'search' });
  const result = run([old, fresh], { apply: true, priorReviews: [{ job: old }], reviews: 1, cap: 1 });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), [fresh.id]);
  assert.ok(!result.events.some(event => event.stage === 'detail' && event.id === old.id), 'known recommendations must not delay unseen jobs');
  assert.ok(result.history.some(record => record.jobId === fresh.id && record.submittedByMyasis));
});

test('completed rejections use no model call or review slot even after full-description edits', () => {
  const old = job('unchanged');
  const changed = job('changed', { detailDescription: 'A genuinely different job description.' });
  const result = run([old, changed], { apply: true, reviews: 1, cap: 1, priorReviews: [{ job: old }, { job: changed }] });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), []);
  assert.match(result.output, /already reviewed/);
  assert.equal(result.events.filter(event => event.stage === 'detail').length,0);
});

test('completed rejections survive candidate changes and explicit user choices still bypass them', () => {
  const changed = job('profile-change');
  const result = run([changed], { priorReviews: [{ job: changed, changedContext: true }] });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), []);
  const chosen = job('chosen', { source: 'chosen' });
  const override = run([chosen], { apply: true, priorReviews: [{ job: chosen }] });
  assert.ok(override.history.some(record => record.jobId === chosen.id));
});

test('rejection memory is scoped by board even when both boards reuse the same job id', () => {
  const old = job('same-id');
  const other = job('same-id', { platform: 'indeed' });
  const result = run([other], { platform: 'indeed', priorReviews: [{ job: old }] });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), [other.id]);
});

test('parallel discovery skips completed rejections and preserves its review allowance', () => {
  const old = job('old-seek', { detailDelayMs: 40 });
  const changed = job('changed-indeed', { platform: 'indeed', detailDescription: 'Changed requirements.' });
  const result = run([old, changed], { apply: true, workers: 2, reviews: 1, cap: 1, priorReviews: [{ job: old }, { job: changed }] });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), []);
  assert.equal(result.events.filter(event => event.stage === 'detail').length,0);
});

test('completed matches remain applyable and do not consume the new-review allowance',()=>{
  const matched=job('past-match'),rejected=job('past-rejection'),fresh=job('fresh-review');
  const result=run([matched,rejected,fresh],{apply:true,reviews:1,cap:2,
    completed:[{job:matched,decision:'apply'},{job:rejected,decision:'skip'}]});
  assert.deepEqual(result.events.filter(x=>x.stage==='fit').map(x=>x.id),[fresh.id]);
  assert.deepEqual(result.events.filter(x=>x.stage==='fit-reused').map(x=>x.id),[matched.id]);
  assert.deepEqual(result.history.filter(x=>x.submittedByMyasis).map(x=>x.jobId).sort(),[fresh.id,matched.id].sort());
  assert.ok(!result.events.some(x=>x.stage==='detail'&&x.id===rejected.id));
});

test('Get Owtomated can complete 200 new reviews and never starts review 201',()=>{
  const jobs=Array.from({length:201},(_,i)=>job('review-'+i,{fitReject:true}));
  const result=run(jobs,{reviews:200});
  assert.equal(result.events.filter(x=>x.stage==='fit').length,200);
  assert.ok(!result.events.some(x=>x.stage==='detail'&&x.id===jobs[200].id));
  assert.match(result.output,/evaluation cap \(200\) reached/);
});

const retryMatch=(listing:FixtureJob):TechnicalRetryCandidate=>({key:`${listing.platform}:${listing.id}`,reason:'Browser disconnected before submission',failedAt:new Date().toISOString(),
 job:{...listing,fitReview:{score:90,reason:'Previously matched',evidence:['Saved match'],contentFingerprint:'old',contextFingerprint:'old'}}});

test('technical fallback tries fresh matches first, then fills only the matching shortfall without another review',()=>{
 const old=job('old-failure'),fresh=job('fresh-match');
 const result=run([old,fresh],{apply:true,cap:2,reviews:2,retries:[retryMatch(old)]});
 assert.deepEqual(result.events.filter(x=>x.stage==='fit').map(x=>x.id),[fresh.id]);
 assert.deepEqual(result.events.filter(x=>x.stage==='apply').map(x=>x.id),[fresh.id,old.id]);
 assert.equal(result.events.filter(x=>x.stage==='retry-fallback').length,1);
 assert.equal(result.events.find(x=>x.stage==='retry-fallback')?.shortfall,1);
});

test('technical fallback stays unused when the online search finds enough matches',()=>{
 const old=job('old-failure');
 const result=run([old,job('fresh-one'),job('fresh-two')],{apply:true,cap:2,reviews:2,retries:[retryMatch(old)]});
 assert.equal(result.events.some(x=>x.stage==='retry-fallback'),false);
 assert.equal(result.events.some(x=>x.stage==='apply'&&x.id===old.id),false);
});

test('technical fallback preserves a saved approval and ignores its old pending-search hold',()=>{
 const old=job('approved-failure'),retry=retryMatch(old);
 retry.approval={id:'00000000-0000-4000-8000-000000000001',revision:'original',job:old,preparedAt:new Date().toISOString(),formUrl:old.url,
  coverLetter:'Exact previously approved letter',resume:'Approved CV.pdf',answers:[{question:'Notice',answer:'Immediate'}]};
 const result=run([old],{apply:true,cap:1,retries:[retry],pendingKeys:['listing:seek:'+old.id]});
 const applied=result.events.find(x=>x.stage==='apply');
 assert.equal(applied?.id,old.id);assert.deepEqual(applied?.approval,retry.approval);
 assert.equal(result.events.some(x=>x.stage==='fit'),false);
 assert.match(result.output,/saved application submitted/);
});

test('technical fallback makes only one attempt per saved job in a run and does not repeat new failures immediately',()=>{
 const old=job('still-broken',{preSendFailure:true});
 const result=run([old],{apply:true,cap:2,retries:[retryMatch(old)]});
 assert.equal(result.events.filter(x=>x.stage==='apply'&&x.id===old.id).length,1);
 assert.equal(result.events.filter(x=>x.stage==='retry-fallback').length,1);
 const fresh=job('new-technical-failure',{preSendFailure:true});
 const enough=run([fresh],{apply:true,cap:1,retries:[retryMatch(old)]});
 assert.equal(enough.events.some(x=>x.stage==='retry-fallback'),false,'the condition is insufficient matches, not simply failed submissions');
});

test('technical fallback is shared between workers and keeps known duplicates and expired jobs out',()=>{
 const seek=job('seek-retry'),indeed=job('indeed-retry',{platform:'indeed'});
 const result=run([seek,indeed],{apply:true,workers:2,cap:2,retries:[retryMatch(seek),retryMatch(indeed)]});
 assert.equal(result.events.filter(x=>x.stage==='retry-fallback').length,1);
 assert.deepEqual(result.history.map(x=>x.jobId).sort(),[seek.id,indeed.id].sort());
 const expired=job('expired-retry',{ageDays:30});
 const blocked=run([expired],{apply:true,cap:1,maxAgeDays:10,retries:[retryMatch(expired)]});
 assert.equal(blocked.events.some(x=>x.stage==='apply'),false);
});

test('technical fallback never submits during Semi auto preparation or search-only scans',()=>{
 const old=job('old-failure');
 for(const options of [{apply:true,prepare:true},{apply:false}]){
  const result=run([old],{...options,retries:[retryMatch(old)]});
  assert.equal(result.events.some(x=>x.stage==='retry-fallback'),false);
 }
});

test('two pages of remembered jobs do not hide fresh listings on page three', () => {
  const old = Array.from({ length: 64 }, (_, i) => job(`rejected-${i}`, { searchOnlyJob: true, searchPage: i < 32 ? 1 : 2 }));
  const fresh = job('page-three-new', { searchOnlyJob: true, searchPage: 3 });
  const result = run([...old, fresh], { apply: true, reviews: 1, cap: 1, priorReviews: old.map(job => ({ job })) });
  assert.deepEqual(result.events.filter(event => event.stage === 'search').map(event => event.pageNumber), [1, 2, 3]);
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), [fresh.id]);
  assert.ok(!result.events.some(event => event.stage === 'detail' && event.id.startsWith('rejected-')));
});

test('confirmed execution visits only the selected prepared jobs and never discovers replacements', () => {
  const result = run([job('selected'), job('unselected'), job('fresh', { searchOnlyJob: true })], { apply: true, approvedIds: ['selected'], reviews: 3 });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['selected']);
  assert.equal(result.events.filter(event => event.stage === 'search').length, 0);
  assert.equal(result.events.filter(event => event.stage === 'fit').length, 0, 'the candidate already confirmed this curated job');
});

test('pending confirmation jobs do not consume future evaluation slots', () => {
  const result = run([job('pending'), job('fresh')], { pendingKeys: ['listing:seek:pending'] });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['fresh']);
});

test('a large discovered queue cannot spend instruction calls beyond its reserved review budget', () => {
  const result = run(Array.from({ length: 500 }, (_, index) => job(`queue-${index}`)), {
    instructions: 'Avoid manager roles.', reviews: 2,
  });
  assert.equal(result.events.filter(event => event.stage === 'instruction').length, 0);
  assert.equal(result.events.filter(event => event.stage === 'detail').length, 2);
  assert.equal(result.events.filter(event => event.stage === 'fit').length, 2);
});

test('instructions are judged by the full matcher after checking for an existing application', () => {
  const result = run([job('excluded', { cardConflict: true }), job('other', { platform: 'indeed' })], {
    instructions: 'Avoid manager roles.', workers: 2, reviews: 1, apply: true,
  });
  assert.equal(result.events.filter(event => event.stage === 'instruction').length, 0);
  assert.deepEqual(result.events.filter(event => event.stage === 'detail').map(event => event.id), ['excluded']);
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['excluded']);
  assert.equal(result.events.filter(event => event.stage === 'apply').length, 0);
  assert.equal(result.history.length, 0, 'a screening rejection must never become an application record');
});

test('feed descriptions go directly through the full fit review without a redundant card check', () => {
  const result = run([job('feed', { description: 'Complete source description.' })], { instructions: 'Avoid manager roles.' });
  assert.equal(result.events.filter(event => event.stage === 'instruction').length, 0);
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['feed']);
});

test('the four run-518 review URLs submit through the real coordinator with free-plan external allowance zero', () => {
  const ids = ['95237902', '95234091', '95299570', '95220951'];
  const result = run(ids.map(id => job(id, { url: `https://www.seek.com.au/job/${id}`, formUrl: `https://au.seek.com/job/${id}/apply/review` })), {
    apply: true, cap: 5, reviews: 30, externalLimit: 0,
  });
  assert.equal(result.events.filter(event => event.stage === 'denied').length, 0);
  assert.deepEqual(result.history.filter(record => record.submittedByMyasis).map(record => record.jobId), ids);
  assert.match(result.output, /Run complete: 4 new application/);
});

test('a free-plan run can review thirty jobs without reviewing the thirty-first', () => {
  const result = run(Array.from({ length: 31 }, (_, i) => job(`free-${i}`, { fitReject: i < 30 })), { apply: true, cap: 5, reviews: 30, externalLimit: 0 });
  assert.equal(result.events.filter(event => event.stage === 'fit').length, 30);
  assert.equal(result.events.filter(event => event.stage === 'detail').length, 30);
  assert.equal(result.events.some(event => event.id === 'free-30' && event.stage === 'fit'), false);
  assert.equal(result.events.filter(event => event.stage === 'apply').length, 0);
});

test('a free account with one application left cannot send a second application', () => {
  const result = run(['first', 'second'].map(id => job(id, { formUrl: `https://au.seek.com/job/${id}/apply/review` })), {
    apply: true, cap: 1, reviews: 30, externalLimit: 0,
  });
  assert.equal(result.events.filter(event => event.stage === 'finish').length, 1);
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, 1);
});

for (const platform of ['seek', 'indeed'] as const) test(`${platform} applied markers skip fit review and leave the slot for a new job`, () => {
  const result = run([job('old', { platform, detailApplied: true }), job('new', { platform })], { platform });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['new']);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].jobId, 'old');
  assert.equal(result.history[0].submittedByMyasis, false, 'existing applications are remembered without counting as new submissions');
});

test('the extension review queue leaves its evaluation slot for a fresh job after an applied marker', () => {
  const result = run([job('old', { detailApplied: true }), job('new')], { queue: true });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['new']);
  assert.equal(result.history[0].jobId, 'old');
  assert.match(result.output, /1 added/);
});

test('fifty known applications leave all one hundred evaluations available for fresh jobs', () => {
  const old = Array.from({ length: 50 }, (_, i) => job(`old-${i}`, { cardConflict: true }));
  const fresh = Array.from({ length: 100 }, (_, i) => job(`fresh-${i}`));
  const result = run([...old, ...fresh], {
    reviews: 100, cap: 100, instructions: 'Avoid manager roles.',
    history: old.map(item => ({ jobId: item.id, title: item.title, company: item.company,
      location: item.location, url: item.url, appliedAt: new Date().toISOString(), platform: 'seek',
      score: 0, scoreReasons: [], submittedByMyasis: false })),
  });
  assert.equal(result.events.filter(event => event.stage === 'instruction').length, 0);
  for (const stage of ['detail', 'fit']) {
    assert.deepEqual(result.events.filter(event => event.stage === stage).map(event => event.id), fresh.map(item => item.id));
  }
  assert.equal(result.history.length, 50);
});

test('an applied marker already present during discovery skips instruction screening and detail reads', () => {
  const result = run([job('old', { alreadyApplied: true, cardConflict: true }), job('new')], { instructions: 'Avoid manager roles.' });
  assert.equal(result.events.filter(event => event.stage === 'instruction').length, 0);
  for (const stage of ['detail', 'fit']) {
    assert.deepEqual(result.events.filter(event => event.stage === stage).map(event => event.id), ['new']);
  }
  assert.equal(result.history[0].jobId, 'old');
});

for (const loadingFirst of [false, true]) test(`an applied marker is checked before a card rejection can spend the slot (loading retry: ${loadingFirst})`, () => {
  const result = run([job('old', { detailApplied: true, cardConflict: true, loadingFirst }), job('new')], { instructions: 'Avoid manager roles.' });
  assert.equal(result.events.filter(event => event.stage === 'instruction').length, 0);
  for (const stage of ['fit']) {
    assert.deepEqual(result.events.filter(event => event.stage === stage).map(event => event.id), ['new']);
  }
  assert.equal(result.history[0].jobId, 'old');
});

test('known application destinations are excluded even under a different listing ID', () => {
  const old = job('original');
  const result = run([job('mirror', { applicationUrl: old.url }), job('new')], {
    history: [{ jobId: old.id, title: old.title, company: old.company, location: old.location, url: old.url,
      appliedAt: new Date().toISOString(), platform: 'seek', score: 0, scoreReasons: [], submittedByMyasis: false }],
  });
  assert.deepEqual(result.events.filter(event => event.stage === 'detail').map(event => event.id), ['new']);
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['new']);
});

test('a different listing remains eligible even when the vacancy metadata matches previous history', () => {
  const old = job('original');
  const result = run([job('repost', { title: old.title, location: 'Remote' }), job('new')], {
    history: [{ jobId: old.id, title: old.title, company: old.company, location: old.location, url: old.url,
      appliedAt: new Date().toISOString(), platform: 'seek', score: 0, scoreReasons: [], submittedByMyasis: false }],
  });
  assert.deepEqual(result.events.filter(event => event.stage === 'detail').map(event => event.id), ['repost']);
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['repost']);
});

test('an unusable fit review does not exhaust the review budget', () => {
  const result = run([job('bad', { fitError: true }), job('new')], { concurrency: 3 });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['bad', 'new']);
  assert.match(result.output, /✓ 90 · Developer new/);
});

test('review-limit notice waits for failed in-flight reviews to return their slots and is printed once', () => {
  const result = run([
    job('bad-one', { fitError: true }), job('good-one', { fitReject: true }),
    job('bad-two', { fitError: true }), job('good-two', { fitReject: true }),
    job('unused'),
  ], { concurrency: 3, reviews: 2 });
  assert.equal(result.events.filter(event => event.stage === 'fit').length, 4);
  assert.equal((result.output.match(/evaluation cap \(2\) reached/g) ?? []).length, 1);
  assert.ok(result.output.indexOf('evaluation cap (2) reached') > result.output.lastIndexOf('fit check failed'));
});

test('an applied marker revealed by a loading retry returns the slot before fit review', () => {
  const result = run([job('old', { detailApplied: true, loadingFirst: true }), job('new')]);
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['new']);
  assert.equal(result.events.filter(event => event.stage === 'detail' && event.id === 'old').length, 2);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].jobId, 'old');
});

test('parallel applied-marker discovery returns the final slot for the other platform', () => {
  const result = run([job('old', { detailApplied: true, detailDelayMs: 30 }), job('new', { platform: 'indeed' })], {
    apply: true, workers: 2, reviews: 1,
  });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['new']);
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['new']);
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, 1);
});

test('duplicates found only by the employer restore the slot and allow the next new job', () => {
  const result = run([job('duplicate', { lateApplied: true }), job('new')], { apply: true });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['duplicate', 'new']);
  assert.match(result.output, /Review slot restored: Developer duplicate/);
  assert.match(result.output, /Run complete: 1 new application/);
  assert.ok(result.history.some(record => record.jobId === 'new' && record.submittedByMyasis === true));
});


test('the complete main pipeline overlaps two platform applications while sharing the run cap and history', () => {
  const result = run([
    job('seek-one', { delayMs: 100 }), job('indeed-one', { platform: 'indeed', delayMs: 100 }),
    job('seek-two'), job('indeed-two', { platform: 'indeed' }),
  ], { apply: true, workers: 2, cap: 2, reviews: 10 });
  const starts = result.events.filter(event => event.stage === 'apply');
  const finishes = result.events.filter(event => event.stage === 'finish');
  assert.equal(starts.length, 2);
  assert.ok(starts[1].at < finishes[0].at, 'both applications must overlap, not merely alternate');
  assert.equal(result.history.length, 2);
  for (const worker of ['seek', 'indeed']) {
    for (const phase of ['waiting', 'applying', 'finished']) {
      assert.ok(result.events.some(event => event.stage === `activity-${phase}` && event.id === worker), `${worker} reports ${phase}`);
    }
  }
  assert.deepEqual(result.history.map(record => record.platform).sort(), ['indeed', 'seek']);
  assert.match(result.output, /Application workers: 2/);
  assert.match(result.output, /Run complete: 2 new application/);
});

test('platform reviews overlap on their own pages and each finished fit is consumed once', () => {
  const result = run([
    job('seek-one', { detailDelayMs: 100, fitDelayMs: 30 }),
    job('seek-two'),
    job('indeed-one', { platform: 'indeed', detailDelayMs: 100, fitDelayMs: 30 }),
    job('indeed-two', { platform: 'indeed' }),
  ], { apply: true, workers: 2, cap: 2, reviews: 2, concurrency: 1 });
  const starts = result.events.filter(event => event.stage === 'detail');
  const ends = result.events.filter(event => event.stage === 'detail-finish');
  assert.equal(starts.length, 2, 'in-flight reads reserve the last two evaluation slots');
  assert.ok(starts[1].at < ends[0].at, 'the listing reads must actually overlap');
  assert.deepEqual(starts.map(event => [event.id, event.page]).sort(), [['indeed-one', 1], ['seek-one', 0]]);
  let fitting = 0, maximum = 0;
  for (const event of result.events) {
    if (event.stage === 'fit') maximum = Math.max(maximum, ++fitting);
    if (event.stage === 'fit-finish') fitting--;
  }
  assert.equal(maximum, 1, 'parallel reads must not multiply the configured fit concurrency');
  assert.equal(result.history.length, 2, 'a fit awaited by both workers creates only one candidate');
  assert.equal(new Set(result.history.map(record => record.jobId)).size, 2);
  assert.match(result.output, /2 qualifying jobs/);
  for (const [worker, page] of [['seek', 0], ['indeed', 1]]) {
    const reviews = result.events.filter(event => event.stage === 'activity-reviewing' && event.id === worker);
    assert.ok(reviews.length);
    assert.ok(reviews.every(event => event.page === page), 'review activity follows only the owning worker page');
  }
});

test('out-of-order model results respect a multi-call ceiling without losing or duplicating candidates', () => {
  const result = run(Array.from({ length: 8 }, (_, i) => job(`job-${i}`, {
    platform: i % 2 ? 'indeed' : 'seek', detailDelayMs: 5, fitDelayMs: [70, 10, 60, 20][i % 4],
  })), { apply: true, workers: 2, cap: 4, reviews: 4, concurrency: 3 });
  let fitting = 0, maximum = 0;
  for (const event of result.events) {
    if (event.stage === 'fit') maximum = Math.max(maximum, ++fitting);
    if (event.stage === 'fit-finish') fitting--;
  }
  assert.ok(maximum > 1 && maximum <= 3);
  assert.equal(result.events.filter(event => event.stage === 'fit').length, 4);
  assert.equal(result.history.length, 4);
  assert.equal(new Set(result.history.map(record => record.jobId)).size, 4);
  assert.match(result.output, /4 qualifying jobs/);
});

test('a verification wall on one board leaves the other platform reviewing and applying', () => {
  const result = run([job('blocked', { wall: true }), job('unused'), job('fresh', { platform: 'indeed', detailDelayMs: 30 })],
    { apply: true, workers: 2, cap: 2, reviews: 3 });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['fresh']);
  assert.ok(result.history.some(record => record.jobId === 'fresh' && record.submittedByMyasis));
  assert.match(result.output, /SEEK is left out for the rest of this run/);
});

for (const fault of ['detailError', 'fitError'] as const) test(`parallel ${fault} returns the final review slot and wakes the other platform`, () => {
  const result = run([
    job('seek-unusable', { [fault]: true, detailDelayMs: 30 }),
    job('indeed-fresh', { platform: 'indeed' }),
  ], { apply: true, workers: 2, cap: 1, reviews: 1, concurrency: 3 });
  assert.equal(result.events.filter(event => event.stage === 'apply').length, 1);
  assert.ok(result.history.some(record => record.jobId === 'indeed-fresh' && record.submittedByMyasis));
  assert.equal(result.events.filter(event => event.stage === 'fit' && event.id === 'indeed-fresh').length, 1);
});

test('a board-confirmed duplicate never reaches the application agent', () => {
  const result = run([
    job('seek-duplicate', { detailApplied: true, lateApplied: true, detailDelayMs: 30 }),
    job('indeed-fresh', { platform: 'indeed' }),
  ], { apply: true, workers: 2, cap: 1, reviews: 1, concurrency: 3 });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['indeed-fresh']);
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['indeed-fresh']);
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, 1);
  assert.ok(result.history.some(record => record.jobId === 'indeed-fresh' && record.submittedByMyasis));
});

test('an idle platform exits cleanly while the other platform reviews its remaining jobs', () => {
  const result = run([job('seek-only', { detailDelayMs: 30 })], { apply: true, workers: 2, cap: 2, reviews: 4 });
  assert.equal(result.events.filter(event => event.stage === 'apply').length, 1);
  assert.ok(result.events.some(event => event.stage === 'activity-finished' && event.id === 'indeed'));
  assert.match(result.output, /Run complete: 1 new application/);
});

test('parallel workers resume fallback discovery once and share its new listings without re-reviewing old ones', () => {
  const result = run([
    job('old', { platform: 'indeed', source: 'recommended', lateApplied: true, delayMs: 40 }),
    job('fallback', { searchOnlyJob: true, source: 'search', detailDelayMs: 20 }),
  ], { apply: true, workers: 2, cap: 1, reviews: 1 });
  assert.equal(result.events.filter(event => event.stage === 'search' && event.id === 'seek').length, 1);
  assert.ok(result.events.filter(event => event.stage === 'search' && event.id === 'indeed').length <= 1,
    'the other board is unnecessary if the first fresh application already fills the target');
  // Either platform may claim the final shared slot first. If the fresh job
  // submits first, the old listing need not be opened at all.
  assert.ok(result.events.filter(event => event.stage === 'detail' && event.id === 'old').length <= 1);
  assert.equal(result.events.filter(event => event.stage === 'fit' && event.id === 'fallback').length, 1);
  assert.ok(result.history.some(record => record.jobId === 'fallback' && record.submittedByMyasis));
});
test('the coordinator defers destinations unknown until form opening to the agent and permits distinct cross-platform applications', () => {
  const result = run([
    job('seek-one', { formUrl: 'https://employer.fixture.invalid/apply?job=1', delayMs: 80 }),
    job('indeed-one', { platform: 'indeed', formUrl: 'https://employer.fixture.invalid/apply?job=1', delayMs: 100 }),
    job('indeed-other', { platform: 'indeed', formUrl: 'https://employer.fixture.invalid/other-form?job=1' }),
  ].map(item => ({...item,title:'The same vacancy'})), { apply: true, workers: 2, cap: 3, reviews: 10 });
  assert.equal(result.events.filter(event => event.stage === 'denied').length, 0);
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, 3);
});
test('an unconfirmed result leaves the allowance available while confirmed sends still obey the shared cap', () => {
  const result = run([job('seek-one', { uncertain: true, delayMs: 50 }), job('indeed-one', { platform: 'indeed' })],
    { apply: true, workers: 2, cap: 1, reviews: 10 });
  assert.equal(result.events.filter(event => event.stage === 'apply').length, 2);
  const confirmed=result.history.filter(record=>record.confirmationStatus!=='unconfirmed');
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].submittedByMyasis, true);
  assert.equal(confirmed[0].jobId, 'indeed-one');
  assert.equal(result.history.filter(record=>record.confirmationStatus==='unconfirmed').length,1);
});
test('a known pre-send failure leaves the shared slot available for the other platform', () => {
  const result = run([job('seek-one', { preSendFailure: true, delayMs: 50 }), job('indeed-one', { platform: 'indeed' })],
    { apply: true, workers: 2, cap: 1, reviews: 10 });
  assert.equal(result.events.filter(event => event.stage === 'apply').length, 2);
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, 1);
});
test('a late duplicate on one platform wakes the other worker when its review slot is restored', () => {
  const result = run([job('old', { platform: 'indeed', source: 'recommended', lateApplied: true, delayMs: 80 }), job('fresh', { source: 'search' })],
    { apply: true, workers: 2, cap: 1, reviews: 1 });
  assert.ok(result.history.some(record => record.jobId === 'fresh' && record.submittedByMyasis === true));
});
test('an isolated-session sign-in failure falls back before any form is opened and does not submit twice', () => {
  const result = run([job('seek-one'), job('indeed-one', { platform: 'indeed' })],
    { apply: true, workers: 2, cap: 2, reviews: 10, failedParallelSignin: true });
  assert.match(result.output, /Application workers: 1/);
  assert.equal(result.events.filter(event => event.stage === 'apply').length, 2);
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, 2);
});


for (const prepare of [false, true]) test(`${prepare ? 'Semi auto' : 'Auto apply'} stops the other platform's reviews when the shared run cap is reached`, () => {
  const result = run([
    job('seek-one', { applyWaitFor: { stage: 'detail', id: 'indeed-rejected-0' } }), job('seek-two'), job('seek-unused'),
    ...Array.from({ length: 8 }, (_, i) => job(`indeed-rejected-${i}`, {
      platform: 'indeed', detailWaitFor: { stage: 'activity-finished', id: 'seek' }, fitReject: true,
    })),
  ], { apply: true, prepare, workers: 2, cap: 2, reviews: 20 });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['seek-one', 'seek-two']);
  assert.equal(result.events.filter(event => event.stage === 'detail' && event.id.startsWith('indeed')).length, 1,
    'only the already-open listing may finish; no further review starts after the cap');
  assert.equal(result.events.filter(event => event.stage === 'fit' && event.id.startsWith('indeed')).length, 0,
    'an in-flight listing read must not launch another model check after the cap');
  assert.equal(result.events.filter(event => event.stage === 'activity-finished').length, 2);
  assert.equal(result.history.length, prepare ? 0 : 2);
  assert.match(result.output, prepare ? /Semi auto complete: 2 application/ : /Run complete: 2 new application/);
});

test('the last submission interrupts the other worker cooldown instead of keeping the run active', () => {
  const result = run([
    job('seek-one', { delayMs: 10 }), job('seek-unused'),
    job('indeed-one', { platform: 'indeed', delayMs: 300 }),
  ], { apply: true, workers: 2, cap: 2, reviews: 10, cooldownMs: 5000 });
  const sent = result.events.filter(event => event.stage === 'finish');
  assert.equal(sent.length, 2);
  const lastSent = Math.max(...sent.map(event => event.at));
  const finished = result.events.filter(event => event.stage === 'activity-finished');
  assert.equal(finished.length, 2);
  assert.ok(Math.max(...finished.map(event => event.at)) - lastSent < 1000, 'workers must finish promptly after the final send');
  assert.equal(result.history.length, 2);
});

test('the daily cap also ends a parallel review loop before the larger run cap', () => {
  const result = run([
    job('seek-one', { delayMs: 10 }),
    ...Array.from({ length: 5 }, (_, i) => job(`indeed-rejected-${i}`, { platform: 'indeed', detailDelayMs: 100, fitReject: true })),
  ], { apply: true, workers: 2, cap: 5, dailyCap: 1, reviews: 20 });
  assert.equal(result.history.length, 1);
  assert.equal(result.events.filter(event => event.stage === 'detail' && event.id.startsWith('indeed')).length, 1);
  assert.equal(result.events.filter(event => event.stage === 'activity-finished').length, 2);
});


for (const minimum of [60, 75, 100]) test(`the ${minimum}% match filter includes its exact boundary and skips a lower score`, () => {
  const result = run([
    job('below', { matchScore: minimum - 1 }), job('boundary', { matchScore: minimum }),
  ], { apply: true, minScore: minimum, reviews: 2 });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['boundary']);
  assert.equal(result.history.length, 1);
});

test('joined employer exclusions block preparation before consuming a review slot', () => {
  const result = run([
    job('excluded-joined', { company: 'TPG Telecom' }),
    job('excluded-spaced', { company: 'InsightTimer Pty Ltd' }),
    job('eligible'),
  ], { apply: true, prepare: true, excludedCompanies: ['tpgtelecom', 'Insight Timer'], reviews: 1 });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['eligible']);
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['eligible']);
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, 0);
});

for (const maximum of [20, 30]) test(`exact company and ${maximum}-day age filters exclude jobs before AI review without hiding an eligible listing`, () => {
  const result = run([
    job('excluded-company', { company: 'Commonwealth Bank of Australia' }),
    job('too-old', { ageDays: maximum + 1 }),
    job('eligible', { ageDays: maximum }),
  ], { apply: true, maxAgeDays: maximum, excludedCompanies: ['Commonwealth Bank of Australia'], reviews: 1 });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['eligible']);
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['eligible']);
  assert.equal(result.history.length, 1);
});


test('parallel scheduled runs can exceed ten sends and share the remaining 100-application daily allowance', () => {
  const batch = (prefix: string, size: number) => Array.from({ length:size }, (_, i) => job(`${prefix}-${i}`, { platform:i%2?'indeed':'seek' }));
  const first = run(batch('morning',70), {apply:true, workers:2, cap:100, dailyCap:100, reviews:70});
  assert.equal(first.events.filter(event => event.stage==='finish').length,70);
  const second = run(batch('afternoon',70), {apply:true, workers:2, cap:100, dailyCap:100, reviews:70, history:first.history});
  assert.equal(second.events.filter(event => event.stage==='finish').length,30);
  assert.equal(second.history.filter(record => record.submittedByMyasis).length,100);
  assert.equal(second.events.filter(event => event.stage==='activity-finished').length,2);
  const third = run(batch('evening',5), {apply:true, workers:2, cap:100, dailyCap:100, reviews:70, history:second.history});
  assert.equal(third.events.filter(event => event.stage==='apply').length,0);
  assert.equal(third.history.filter(record => record.submittedByMyasis).length,100);
});

for (const prepare of [false, true]) test(`${prepare ? 'Semi auto' : 'Auto apply'} matching serializes a known shared employer destination across boards`, () => {
  const applicationUrl = 'https://employer.fixture.invalid/jobs/known-shared-posting';
  const result = run([
    job('seek-shared', { applicationUrl, delayMs: 100 }),
    job('indeed-shared', { platform: 'indeed', applicationUrl, delayMs: 100 }),
    job('fresh-next', { platform: 'indeed' }),
  ], { apply: true, prepare, workers: 2, cap: 2, reviews: 5 });
  const attempts = result.events.filter(event => event.stage === 'apply').map(event => event.id);
  assert.equal(attempts.filter(id => id.endsWith('-shared')).length, 1);
  assert.ok(attempts.includes('fresh-next'), 'a duplicate alias leaves application capacity for another new job');
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, prepare ? 0 : 2);
});

test('a failed attempt does not prevent a different board from applying through the same known destination', () => {
  const applicationUrl = 'https://employer.fixture.invalid/jobs/retry-safe-posting';
  const result = run([
    job('seek-failed', { applicationUrl, delayMs: 30, preSendFailure: true }),
    job('indeed-retry', { platform: 'indeed', applicationUrl, detailDelayMs: 100 }),
  ], { apply: true, workers: 2, cap: 2, reviews: 5 });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['seek-failed', 'indeed-retry']);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].jobId, 'indeed-retry');
});

test('an unconfirmed send cannot be repeated through a known cross-board alias in the same run', () => {
  const applicationUrl = 'https://employer.fixture.invalid/jobs/uncertain-posting';
  const result = run([
    job('seek-uncertain', { applicationUrl, delayMs: 30, uncertain: true }),
    job('indeed-alias', { platform: 'indeed', applicationUrl, detailDelayMs: 100 }),
  ], { apply: true, workers: 2, cap: 2, reviews: 5 });
  assert.deepEqual(result.events.filter(event => event.stage === 'apply').map(event => event.id), ['seek-uncertain']);
  assert.equal(result.history.filter(record=>record.confirmationStatus!=='unconfirmed').length, 0, 'uncertain sends are not fabricated into confirmed applications');
  assert.equal(result.history.filter(record=>record.confirmationStatus==='unconfirmed').length,1,'retain the uncertain send for duplicate protection');
});
