import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'application-review-session-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', APPLICATION_REVIEW_MODE: 'prepare' });
const { config } = await import('./config.js');
const { applicationApprovalGate } = await import('./application-review.js');
config.dryRun = false;
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Original candidate CV');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', fileName: 'CV.txt', label: 'CV' }]));
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
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
  assert.notEqual(await applicationApprovalGate(ctx), null, 'changed answers still require confirmation');
  await page.goto(url.replace('first', 'third').replace('tenant=one', 'tenant=two'));
  assert.notEqual(await applicationApprovalGate(ctx), null, 'changed tenant still requires confirmation');
  await page.goto(url.replace('/123?', '/456?'));
  assert.notEqual(await applicationApprovalGate(ctx), null, 'changed vacancy still requires confirmation');
  await page.goto(url.replace('first', 'fourth'));
  writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Changed candidate CV');
  assert.notEqual(await applicationApprovalGate(ctx), null, 'changed CV bytes still require confirmation');
  assert.equal(submissions, 0, 'checking approval never sends an application');
  console.log('PASS: rotated SEEK sessions preserve existing approval; changed answers, vacancy, tenant and CV require confirmation.');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
