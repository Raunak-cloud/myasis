import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { AppliedRecord, JobListing } from './types.js';

type FixtureJob = JobListing & { detailApplied?: boolean; loadingFirst?: boolean; fitError?: boolean; lateApplied?: boolean; delayMs?: number; formUrl?: string; uncertain?: boolean; preSendFailure?: boolean };
const job = (id: string, extra: Partial<FixtureJob> = {}): FixtureJob => ({
  id, title: `Developer ${id}`, company: 'Fixture Employer', location: 'Sydney',
  url: `https://fixture.invalid/job/${id}`, platform: 'seek', applicationMode: 'hosted', ...extra,
});

/** Exercise the compiled main loop with offline boundary adapters, real history
 * and a one-review budget. No browser, model or employer is contacted. */
function run(jobs: FixtureJob[], options: { history?: AppliedRecord[]; apply?: boolean; platform?: 'seek' | 'indeed'; concurrency?: number; workers?: number; cap?: number; reviews?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-review-budget-'));
  const url = (file: string) => pathToFileURL(join(directory, file)).href;
  try {
    writeFileSync(join(directory, 'profile.txt'), 'Full name: Fixture Candidate\n');
    writeFileSync(join(directory, 'applied.json'), JSON.stringify(options.history ?? []));
    writeFileSync(join(directory, 'jobs.json'), JSON.stringify(jobs));
    writeFileSync(join(directory, 'boundary.mjs'), `
import { readFileSync, appendFileSync } from 'node:fs';
export const jobs = JSON.parse(readFileSync(new URL('./jobs.json', import.meta.url)));
export const record = (stage, id) => appendFileSync(new URL('./events.jsonl', import.meta.url), JSON.stringify({stage,id,at:Date.now()})+'\\n');
`);
    writeFileSync(join(directory, 'config.mjs'), `
export * from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
import { config } from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
Object.assign(config, {keywords:['fixture'],platforms:${JSON.stringify(options.workers === 2 ? ['seek', 'indeed'] : [options.platform ?? 'seek'])},aiInstructions:'',formSpeed:false});
Object.assign(config.coverLetter, {mode:'tailored'});
Object.assign(config.rules, {minScore:0,excludedCompanies:[]});
Object.assign(config.limits, {maxEvaluations:${options.reviews ?? 1},fitConcurrency:${options.concurrency ?? 1},pagesPerKeyword:1,maxApplicationsPerRun:${options.cap ?? 1},maxApplicationsPerDay:100,
  minDelayMs:0,maxDelayMs:0,minNonSubmitDelayMs:0,maxNonSubmitDelayMs:0,searchDelayMs:0});
`);
    writeFileSync(join(directory, 'discovery.mjs'), `
import { jobs, record } from './boundary.mjs';
const reads = new Map();
export const recommended = async () => jobs.filter(job => ${options.workers === 2} ? job.platform === new URL(import.meta.url).searchParams.get('platform') : true);
export const search = async () => [];
export const fetchJobDetail = async (_page, job) => {
  record('detail',job.id);
  const count = (reads.get(job.id) || 0) + 1; reads.set(job.id,count);
  if(job.loadingFirst && count === 1) return {...job,description:'',alreadyApplied:false};
  return {...job,description:'Build software in Sydney.',alreadyApplied:job.detailApplied===true,appliedNote:'You applied on 1 October'};
};
`);
    writeFileSync(join(directory, 'browser.mjs'), `
export const launchBrowser = async () => ({});
export const applicationWorkerContexts = async () => [0,1].map(worker => ({newPage:async()=>({worker}),close:async()=>{}}));
export const getPage = async () => ({});
export const closeBrowser = async () => {};
export const ensureSignedIn = async () => {};
export const ensureIndeedSignedIn = async () => {};
export const workingIn = async () => {};
export const jitter = async () => {};
`);
    writeFileSync(join(directory, 'llm.mjs'), `
import { record } from './boundary.mjs';
export const reviewKey = job => job.platform+':'+job.id;
export const rankJobsForReview = async jobs => new Map(jobs.map(job => [reviewKey(job),{priority:90,reason:'Fixture priority'}]));
export const ruleConflict = async () => ({decision:'allow',conflict:'',because:'',checks:[]});
export const finishedCoverLetterForJob = async () => 'Fixture letter';
export const assessFit = async job => {
  record('fit',job.id);
  if(job.fitError) { await new Promise(done => setTimeout(done,20)); throw Error('Instruction exception review violated its evidence schema'); }
  return {decision:'apply',shouldApply:true,matchScore:90,reason:'Fixture fit',evidence:['Fixture'],injectionSuspected:false};
};
`);
    writeFileSync(join(directory, 'apply.mjs'), `
import { record } from './boundary.mjs';
import { authorizeReservedSubmission } from ${JSON.stringify(new URL('./application-reservations.js', import.meta.url).href)};
export const applyToJobWithAgent = async (_page,job) => {
  record('apply',job.id);
  await new Promise(done=>setTimeout(done,job.delayMs||0));
  if(job.preSendFailure) return {status:'error',jobId:job.id,error:'Fixture failure before send'};
  if(job.formUrl && !authorizeReservedSubmission(job.formUrl)) { record('denied',job.id); return {status:'needs-human',jobId:job.id,reason:'Exact same form'}; }
  record('finish',job.id);
  if(job.uncertain) return {status:'error',jobId:job.id,error:'Fixture uncertain response',submitPressed:true};
  return job.lateApplied ? {status:'already-applied',jobId:job.id,reason:'Already recorded by the employer'}
    : {status:'applied',jobId:job.id,at:new Date().toISOString()};
};
export const applyToIndeedJob = applyToJobWithAgent;
`);
    writeFileSync(join(directory, 'humanizer.mjs'), 'export const assertHumanizerHealthy = async () => {};');
    writeFileSync(join(directory, 'blocker.mjs'), "export const WALL_STATES = new Set(['captcha','login','identity']); export const judgePage = async () => ({state:'loading',reason:'Fixture delayed listing'});");
    const overrides: Record<string, string> = {
      './config.js': 'config.mjs', './browser.js': 'browser.mjs', './llm.js': 'llm.mjs',
      './discovery.js': 'discovery.mjs', './discovery-indeed.js': 'discovery.mjs',
      './agent/apply-agent.js': 'apply.mjs', './apply-indeed.js': 'apply.mjs', './humanizer.js': 'humanizer.mjs', './blocker.js': 'blocker.mjs',
    };
    const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8').replace(
      /from ['"](\.\.?\/[^'"]+)['"]/g,
      (_match, specifier: string) => `from ${JSON.stringify(overrides[specifier] ? url(overrides[specifier]) + (specifier === './discovery.js' ? '?platform=seek' : specifier === './discovery-indeed.js' ? '?platform=indeed' : '') : new URL(specifier, import.meta.url).href)}`,
    );
    writeFileSync(join(directory, 'main.mjs'), main);
    writeFileSync(join(directory, 'start.mjs'), `globalThis.fetch=async()=>{throw Error('HTTP is forbidden by this offline fixture');}; await import('./main.mjs');`);
    const output = execFileSync(process.execPath, [join(directory, 'start.mjs'), ...(options.apply ? [] : ['--search-only'])], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, DATA_DIR: directory, PROFILE_PATH: join(directory, 'profile.txt'),
        CELERIS_API_KEY: 'fixture-only', HUMANIZER_MODE: 'off', COVER_LETTER_MODE: 'tailored',
        APPLICATION_WORKERS: String(options.workers ?? 1), DIRECT_EXTERNAL_JOB_URL: '', TARGETED_JOBS_JSON: '', EMPLOYER_FEEDS_ADMIN_ENABLED: 'false', SMARTRECRUITERS_ADMIN_ENABLED: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const events = readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const history: AppliedRecord[] = JSON.parse(readFileSync(join(directory, 'applied.json'), 'utf8'));
    return { output, events, history };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const platform of ['seek', 'indeed'] as const) test(`${platform} applied markers are skipped before fit review and leave the one-review slot for a new job`, () => {
  const result = run([job('old', { platform, detailApplied: true }), job('new', { platform })], { platform });
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['new']);
  assert.match(result.output, /skipped \(already applied\): Developer old/);
  assert.ok(result.history.some(record => record.jobId === 'old' && record.submittedByMyasis === false));
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

test('an applied marker first revealed by a loading retry is also skipped before fit', () => {
  const result = run([job('old', { detailApplied: true, loadingFirst: true }), job('new')]);
  assert.deepEqual(result.events.filter(event => event.stage === 'fit').map(event => event.id), ['new']);
  assert.equal(result.events.filter(event => event.stage === 'detail' && event.id === 'old').length, 2);
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
  assert.deepEqual(result.history.map(record => record.platform).sort(), ['indeed', 'seek']);
  assert.match(result.output, /Application workers: 2/);
  assert.match(result.output, /Run complete: 2 new application/);
});
test('a shared employer destination is sent once, while different platform forms for the same vacancy remain allowed', () => {
  const result = run([
    job('seek-one', { formUrl: 'https://employer.fixture.invalid/apply?job=1', delayMs: 80 }),
    job('indeed-one', { platform: 'indeed', formUrl: 'https://employer.fixture.invalid/apply?job=1', delayMs: 100 }),
    job('indeed-other', { platform: 'indeed', formUrl: 'https://employer.fixture.invalid/other-form?job=1' }),
  ].map(item => ({...item,title:'The same vacancy'})), { apply: true, workers: 2, cap: 3, reviews: 10 });
  assert.equal(result.events.filter(event => event.stage === 'denied').length, 1);
  assert.equal(result.history.filter(record => record.submittedByMyasis).length, 2);
});
test('an uncertain result consumes the shared allowance; another worker cannot exceed a one-application cap', () => {
  const result = run([job('seek-one', { uncertain: true, delayMs: 50 }), job('indeed-one', { platform: 'indeed' })],
    { apply: true, workers: 2, cap: 1, reviews: 10 });
  assert.equal(result.events.filter(event => event.stage === 'apply').length, 1);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].submittedByMyasis, false);
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
