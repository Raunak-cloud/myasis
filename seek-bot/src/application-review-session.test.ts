import type {ToolContext} from './agent/context.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'application-review-session-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', APPLICATION_REVIEW_MODE: 'prepare' });
const { config } = await import('./config.js');
const { applicationApprovalGate,approvedSeekReviewUrl } = await import('./application-review.js');
config.dryRun = false;
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Original candidate CV');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', fileName: 'CV.txt', label: 'CV' }]));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath:process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  let submissions = 0;
  await page.route('**/*', route => {
    if (route.request().method() === 'POST') submissions++;
    return route.fulfill({ contentType: 'text/html', body: '<form method="post"><label>Name<input required value="Fixture Applicant"></label><button>Submit</button></form>' });
  });
  const url = 'https://employer.fixture.invalid/jobs/123?tenant=one&seek-token=first';
  const job = { id: '123', url: 'https://www.seek.com.au/job/123', title: 'Developer', company: 'Fixture', location: 'Sydney', platform: 'seek' as const };
  await page.goto(url);
  const ctx = { page, job, profile: {} as never, log: () => {}, captured: [], resumeUsed: 'cv', resumeName: 'CV.txt',
    observation: { url, title: '', text: '', actions: [], fields: [] }, actions: [] };
  const prepared = await applicationApprovalGate(ctx);
  assert.ok(prepared?.kind === 'terminal' && prepared.outcome.status === 'prepared');
  const draft = prepared.outcome.draft;
  assert.equal(draft.formUrl, url, 'retain the original token-bearing URL for actual browser use');
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([{ ...draft, revision: 'legacy-session-dependent-revision' }]));
  process.env.APPLICATION_REVIEW_MODE = 'approved';
  await page.goto(url.replace('first', 'second'));
  assert.equal(await applicationApprovalGate(ctx), null, 'unchanged confirmed content survives a new handoff session and legacy revision');
  await page.locator('input').fill('Changed answer');
  { const checked={...ctx} as ToolContext; assert.equal(await applicationApprovalGate(checked),null,'ordinary answer text differences are advisory'); assert.match(checked.formAdvisories?.join(' ')??'',/differs from the approved text/); }
  await page.goto(url.replace('first', 'third').replace('tenant=one', 'tenant=two'));
  assert.notEqual(await applicationApprovalGate(ctx), null, 'changed tenant still requires confirmation');
  await page.goto(url.replace('/123?', '/456?'));
  assert.notEqual(await applicationApprovalGate(ctx), null, 'changed vacancy still requires confirmation');
  await page.goto(url.replace('first', 'fourth'));
  writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Changed candidate CV');
  assert.notEqual(await applicationApprovalGate(ctx), null, 'changed CV bytes still require confirmation');
  writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Original candidate CV');
  const staged={...draft,answers:[],formUrl:job.url,preparation:{version:1 as const,stage:'job-and-letter' as const,access:'no-login-required' as const,checkedAt:new Date().toISOString(),checkedUrl:job.url}};
  writeFileSync(join(directory,'approved-applications.json'),JSON.stringify([staged]));
  await page.goto(url.replace('first','staged'));
  assert.equal(await applicationApprovalGate(ctx),null,'job-and-letter approval permits the completed form after filling, without claiming it was prefilled');
  const listingOnly={...staged,preparation:{version:2 as const,stage:'job-and-letter' as const,access:'not-checked' as const,listingUrl:job.url}};
  writeFileSync(join(directory,'approved-applications.json'),JSON.stringify([listingOnly]));
  assert.equal(await applicationApprovalGate(ctx),null,'listing-only approval is usable after the normal applying agent fills the form');
  const listedJob={...job,id:'12345678',url:'https://www.seek.com.au/job/12345678'};
  const reviewUrl=listedJob.url+'/apply/review';
  writeFileSync(join(directory,'approved-applications.json'),JSON.stringify([{...listingOnly,job:listedJob,formUrl:reviewUrl}]));
  assert.equal(approvedSeekReviewUrl(listedJob),undefined,'an unfilled letter-only draft must start at its listing');
  writeFileSync(join(directory,'approved-applications.json'),JSON.stringify([{...draft,job:listedJob,formUrl:reviewUrl}]));
  assert.equal(approvedSeekReviewUrl(listedJob),reviewUrl,'legacy completed forms still resume their saved review');
  const workdayUrl = 'https://fixture.wd3.myworkdayjobs.com/en-US/External/job/Sydney/Developer_R123/apply/applyManually?tenant=one';
  process.env.APPLICATION_REVIEW_MODE = 'prepare';
  await page.goto(workdayUrl);
  const workdayPrepared = await applicationApprovalGate(ctx);
  assert.ok(workdayPrepared?.kind === 'terminal' && workdayPrepared.outcome.status === 'prepared');
  const workdayDraft = workdayPrepared.outcome.draft;
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([workdayDraft]));
  process.env.APPLICATION_REVIEW_MODE = 'approved';
  await page.goto(workdayUrl.replace('/apply/applyManually', '/apply'));
  assert.equal(await applicationApprovalGate(ctx), null, 'Workday can resume the identical approved vacancy at /apply instead of /apply/applyManually');
  await page.locator('input').fill('Changed Workday answer');
  { const checked={...ctx} as ToolContext; assert.equal(await applicationApprovalGate(checked),null,'ordinary answer text differences are advisory'); assert.match(checked.formAdvisories?.join(' ')??'',/differs from the approved text/); }
  await page.goto(workdayUrl.replace('R123', 'R456'));
  assert.notEqual(await applicationApprovalGate(ctx), null, 'a different Workday requisition cannot inherit confirmation');
  await page.goto(workdayUrl.replace('tenant=one', 'tenant=two'));
  assert.notEqual(await applicationApprovalGate(ctx), null, 'a different Workday tenant cannot inherit confirmation');
  await page.goto(workdayUrl.replace('/External/', '/AnotherSite/'));
  assert.notEqual(await applicationApprovalGate(ctx), null, 'a different Workday career site cannot inherit confirmation');
  await page.goto(workdayUrl.replace('myworkdayjobs.com', 'myworkdayjobs.com.evil.invalid').replace('/apply/applyManually', '/apply'));
  assert.notEqual(await applicationApprovalGate(ctx), null, 'a lookalike host cannot inherit Workday confirmation');
  assert.equal(submissions, 0, 'checking approval never sends an application');
  console.log('PASS: rotated SEEK sessions preserve existing approval; answer differences are advisory; vacancy, tenant and CV protection remains enforced.');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
