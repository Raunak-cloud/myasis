import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-application-review-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.COST_TRACKING = 'false';
process.env.APPLICATION_REVIEW_MODE = 'prepare';
const { config } = await import('./config.js');
const { applicationApprovalGate, applicationContent } = await import('./application-review.js');
const { runAgentOnlyApplication } = await import('./agent/agent-only.js');
const { RunGuards } = await import('./agent/guards.js');
const { CostMeter } = await import('./agent/celeris.js');
config.dryRun = false; config.allowExternalApply = true;
config.celeris.maxSteps = 3;
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), 'Fixture applicant CV');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fixture CV', fileName: 'Fixture CV.txt' }]));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const job = { id: 'review-fixture', title: 'Developer', company: 'Fictional Employer', location: 'Sydney', platform: 'seek' as const, url: 'https://form.fixture.invalid/jobs/1' };
const profile = { name: 'Fixture Applicant', phone: '', email: '', nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' };
let requests = 0;
await page.context().route('**/*', route => {
  if (!new URL(route.request().url()).hostname.endsWith('.invalid')) return route.abort();
  if (route.request().method() === 'POST') requests++;
  return route.fulfill({ contentType: 'text/html', body: '<main><form method="post"><label>Name<input name="name" required value="Fixture Applicant"></label><button>Send application</button></form></main>' });
});
await page.goto(job.url);
const ctx = { page, job, profile, log: () => {}, captured: [{ question: 'Name', answer: 'Fixture Applicant' }], resumeUsed: 'cv', resumeName: 'Fixture CV.txt',
  guards: new RunGuards({ ...config.celeris, meter: new CostMeter(1) }), observation: { url: job.url, title: '', text: '', actions: [], fields: [] }, actions: [] };
const originalFetch = globalThis.fetch;
try {
  const prepared = await applicationApprovalGate(ctx);
  assert.ok(prepared?.kind === 'terminal' && prepared.outcome.status === 'prepared');
  const draft = prepared.outcome.draft;
  assert.equal(requests, 0);
  assert.ok(draft.resumeHash);
  assert.deepEqual(draft.answers, [{ question: 'Name', answer: 'Fixture Applicant' }]);
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([draft]));
  process.env.APPLICATION_REVIEW_MODE = 'approved';
  assert.equal(await applicationApprovalGate(ctx), null, 'only the exact confirmed application can send');
  await page.locator('input').fill('Changed applicant');
  const changed = await applicationApprovalGate(ctx);
  assert.ok(changed?.kind === 'terminal' && changed.outcome.status === 'prepared', 'changed answers return to review');
  await page.locator('input').fill('Fixture Applicant');
  writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), 'A different CV');
  assert.notEqual(await applicationApprovalGate(ctx), null, 'changed document bytes invalidate confirmation');
  writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), 'Fixture applicant CV');
  assert.notEqual(applicationContent({ ...draft, formUrl: 'https://form.fixture.invalid/jobs/2' }), applicationContent(draft), 'a different form target cannot inherit consent');
  assert.notEqual(applicationContent({ ...draft, job: { ...draft.job, description: 'The role requirements changed.' } }), applicationContent(draft), 'changed vacancy requirements invalidate confirmation');
  process.env.APPLICATION_REVIEW_MODE = 'prepare';
  let turn = 0;
  let calls: Array<{ name: string; args: Record<string, unknown> }> = [{ name: 'prepare_application', args: { answers: [{ question: 'Name', answer: 'Fixture Applicant' }], resume_id: 'cv' } }];
  globalThis.fetch = (async () => {
    const call = calls.shift() ?? { name: 'finish', args: { status: 'skipped', reason: 'Fixture complete', evidence: 'Fixture only' } };
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${++turn}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
  }) as typeof fetch;
  const result = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
  assert.equal(result.outcome.status, 'prepared', 'the actual agent returns a filled application for review');
  assert.equal(requests, 0, 'an agent-marked send is held before the browser action');
  calls = [{ name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } }] as typeof calls;
  await runAgentOnlyApplication({ page, job, profile, log: () => {} });
  assert.equal(requests, 0, 'a raw send attempt cannot bypass preparation');
  process.env.APPLICATION_REVIEW_MODE = 'approved';
  calls = [
    { name: 'prepare_application', args: { answers: [{ question: 'Name', answer: 'Fixture Applicant' }], resume_id: 'cv' } },
    { name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } },
    { name: 'finish', args: { status: 'applied', reason: 'Fixture accepted', evidence: 'Fixture receipt' } },
  ] as typeof calls;
  const sent = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
  assert.equal(requests, 1, 'an unchanged application sends only after its exact version was confirmed');
  assert.equal(sent.outcome.status, 'applied');
  console.log('PASS: Semi auto cannot send without confirmation; changed answers, target URLs and resume bytes invalidate approval.');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-application-review-'));
  rmSync(directory, { recursive: true, force: true });
}
