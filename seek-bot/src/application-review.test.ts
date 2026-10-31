import { createReadinessFixtureReply } from './agent/readiness-fixture.js';
const readinessFixtureReply = createReadinessFixtureReply();
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
import type { PreparedApplication } from './application-review-types.js';
import { cleanCoverLetter } from './cover-letter-policy.js';
import { withCoverLetter } from './application-review-content.js';
import { nextApplicationCandidate } from './application-workers.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-application-review-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.COST_TRACKING = 'false';
process.env.RESUME_SELECT = '';
process.env.FORM_CORPUS_DIR = join(directory, 'form-corpus');
process.env.APPLICATION_REVIEW_MODE = 'prepare';
process.env.COVER_LETTER_INSTRUCTIONS = 'Use a direct greeting and concise paragraphs.';
const { config } = await import('./config.js');
const { applicationApprovalGate, applicationContent, approvedSeekReviewUrl } = await import('./application-review.js');
const { runAgentOnlyApplication } = await import('./agent/agent-only.js');
config.dryRun = false; config.allowExternalApply = true;
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
  if (route.request().method() === 'POST') { requests++; return route.fulfill({ contentType: 'text/html', body: '<main>Application received</main>' }); }
  return route.fulfill({ contentType: 'text/html', body: '<main><form method="post"><label>Name<input name="name" required value="Fixture Applicant"></label><button id="send">Send application</button></form></main>' });
});
await page.goto(job.url);
const ctx = { page, job, profile, log: () => {}, captured: [{ question: 'Name', answer: 'Fixture Applicant' }], resumeUsed: 'cv', resumeName: 'Fixture CV.txt',
  observation: { url: job.url, title: '', text: '', actions: [], fields: [] }, actions: [] };
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
  const seekJob = { ...job, id: '95364080', url: 'https://www.seek.com.au/job/95364080' };
  const seekDraft = { ...draft, job: seekJob, formUrl: 'https://au.seek.com/job/95364080/apply/review' };
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([seekDraft]));
  assert.equal(approvedSeekReviewUrl(seekJob), seekDraft.formUrl);
  for (const formUrl of ['https://au.seek.com/job/99999999/apply/review', 'https://au.seek.com/job/95364080/apply/success',
    'https://au.seek.com/job/95364080/apply/review?submit=true', 'https://seek.com.evil.invalid/job/95364080/apply/review',
    'http://au.seek.com/job/95364080/apply/review', 'https://smartapply.indeed.com/beta/indeedapply/form/review-module']) {
    writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([{ ...seekDraft, formUrl }]));
    assert.equal(approvedSeekReviewUrl(seekJob), undefined, `cannot directly resume ${formUrl}`);
  }
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([seekDraft]));
  assert.equal(approvedSeekReviewUrl({ ...seekJob, applicationMode: 'external' }), undefined, 'a changed external listing cannot reuse a hosted draft');
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify([draft]));
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
  let calls: Array<{ name: string; args: Record<string, unknown> }> = [{ name: 'prepare_application', args: { submit_selector: '#send', answers: [{ question: 'Name', answer: 'Fixture Applicant' }], resume_id: 'cv' } }];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const reviewReply = readinessFixtureReply(body); if (reviewReply) return reviewReply;
    if (!body.tools?.length) return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ sends_application: true }) } }] });
    const call = calls.shift() ?? { name: 'finish', args: { status: 'skipped', reason: 'Fixture complete', evidence: 'Fixture only' } };
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${++turn}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
  }) as typeof fetch;
  const result = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
  assert.equal(result.outcome.status, 'prepared', 'the actual agent returns a filled application for review');
  assert.equal(requests, 0, 'an agent-marked send is held before the browser action');
  calls = [{ name: 'browser_action', args: { action: 'click', selector: 'input[type="radio"][value="Missing saved CV"]', sends_application: false } },
    { name: 'finish', args: { status: 'skipped', reason: 'Missing target', evidence: 'Fresh form inspected' } }] as typeof calls;
  const missingStart = performance.now();
  await runAgentOnlyApplication({ page, job, profile, log: () => {} });
  assert.ok(performance.now() - missingStart < 4500, 'submit-control inspection must not wait out the 30-second default for a missing selector');
  assert.equal(requests, 0);
  calls = [{ name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } }] as typeof calls;
  await runAgentOnlyApplication({ page, job, profile, log: () => {} });
  assert.equal(requests, 0, 'a raw send attempt cannot bypass preparation');
  calls = [{ name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'button', name: 'Send application' } } }] as typeof calls;
  await runAgentOnlyApplication({ page, job, profile, log: () => {} });
  assert.equal(requests, 0, 'direct semantic locators retain confirmation even without an agent-supplied send flag');
  for (const action of [
    { action: 'click', selector: '#send' },
    { action: 'press', selector: 'input', value: 'Enter' },
  ]) {
    calls = [{ name: 'browser_batch', args: { actions: [action] } }] as typeof calls;
    await runAgentOnlyApplication({ page, job, profile, log: () => {} });
    assert.equal(requests, 0, 'batch clicks and Enter cannot send by omitting intent either');
  }
  process.env.APPLICATION_REVIEW_MODE = 'approved';
  calls = [{ name: 'browser_action', args: { action: 'press', selector: 'input', value: 'Enter' } }] as typeof calls;
  await runAgentOnlyApplication({ page, job, profile, log: () => {} });
  assert.equal(requests, 0, 'even an approved reconstruction must declare submission intent');
  calls = [
    { name: 'prepare_application', args: { submit_selector: '#send', answers: [{ question: 'Name', answer: 'Fixture Applicant' }], resume_id: 'cv' } },
    { name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'button', name: 'Send application' }, sends_application: true } },
    { name: 'finish', args: { status: 'applied', reason: 'Fixture accepted', evidence: 'Fixture receipt', receipt: { quote: 'Application received' } } },
  ] as typeof calls;
  const sent = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
  assert.equal(requests, 1, 'an unchanged application sends only after its exact version was confirmed');
  assert.equal(sent.outcome.status, 'applied');
  process.env.APPLICATION_REVIEW_MODE = 'prepare';
  await page.goto(job.url);
  await page.locator('form').evaluate(form => {
    const label = document.createElement('label'); label.textContent = 'Cover letter';
    const input = document.createElement('textarea'); input.value = 'Actual letter — still has an em dash';
    label.append(input); form.append(label);
  });
  const unclean = await applicationApprovalGate({ ...ctx, coverLetter: 'Actual letter, still has an em dash' });
  assert.ok(unclean?.kind === 'ok' && unclean.disposition === 'failed', 'actual unsanitized form text blocks preparation even when the recorded letter looks clean');
  // Reproduce the production failure: listing search fields plus an Apply
  // entry link must not be mistaken for a filled application's final send.
  // Exercise five real browser forms, including employer popups and a final
  // "Apply now" control that does need confirmation.
  const drafts: PreparedApplication[] = [];
  const submissions: string[] = [];
  const sentLetters: string[] = [];
  let expectedApproved: PreparedApplication | undefined;
  let changedReview = false;
  await page.context().unroute('**/*');
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!url.hostname.endsWith('.invalid')) return route.abort();
    const id = url.pathname.split('/').at(-1)!;
    if (route.request().method() === 'POST') {
      submissions.push(id);
      sentLetters.push((new URLSearchParams(route.request().postData() ?? '').get('letter') ?? '').replace(/\r\n?/g, '\n'));
      return route.fulfill({ contentType: 'text/html', body: '<main><h1>Application received</h1></main>' });
    }
    const listing = url.pathname.startsWith('/jobs/');
    if (!listing && id === '5' && process.env.APPLICATION_REVIEW_MODE === 'approved') {
      const saved = drafts.find(draft => draft.job.id === id)!;
      const escaped = saved.coverLetter!.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      return route.fulfill({ contentType: 'text/html', body: `<main><h1>Review Prepared Role 5</h1><p>Name: Fixture Applicant. Availability: Two weeks. Resume: Fixture CV.txt</p><form method="post"><input type="hidden" name="letter" value="${escaped}">${changedReview ? '<label>Availability<input value="Three weeks"></label>' : ''}<button id="send">Send application</button></form></main>` });
    }
    const label = ['Apply on company site', 'Apply now', 'Apply', 'Continue application', 'Apply on company site'][Number(id) - 1];
    return route.fulfill({ contentType: 'text/html', body: listing
      ? `<main><h1>Prepared Role ${id}</h1><label>Search jobs<input type="search"></label><a id="entry" href="https://employer.fixture.invalid/apply/${id}" ${Number(id) % 2 ? 'target="_blank"' : ''}>${label}</a></main>`
      : `<main><h1>Prepared Role ${id}</h1><form method="post"><label>Name<input id="name" name="name" required></label><label>Availability<input id="availability" name="availability" required></label><label>Cover letter<textarea id="letter" name="letter"></textarea></label><label>Resume<input type="file" id="cv" name="cv"></label><button id="send">${id === '5' ? 'Apply now' : 'Send application'}</button></form></main>` });
  });
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const reviewReply = readinessFixtureReply(body); if (reviewReply) return reviewReply;
    assert.ok(body.tools?.length, 'the applying agent owns send intent without an independent classifier');
    const call = calls.shift();
    assert.match(body.messages[0].content, /Use a direct greeting and concise paragraphs\./, 'saved preferences are always in the active agent system prompt');
    assert.match(body.messages[0].content, /Never use em dashes/);
    if (process.env.APPLICATION_REVIEW_MODE === 'prepare') assert.match(body.messages[1].content, /SEMI AUTO: fill this application completely/);
    else {
      assert.ok(expectedApproved);
      assert.ok(body.messages[1].content.includes(JSON.stringify(expectedApproved)), 'the exact approved application survives observation compaction on every model turn');
      assert.match(body.messages[1].content, /SUBMIT ONLY THIS APPROVED APPLICATION/);
      assert.match(body.messages[1].content, /Do not open an optional employer preview/);
      assert.doesNotMatch(body.messages[1].content, /SOURCE 1, character/, 'approved runs load the document inventory; full evidence remains available on demand');
    }
    assert.ok(call, 'the browser completes within the planned turns');
    // A stale plan may repeat Apply before noticing its popup. The handoff
    // must cancel that second click and require a fresh form observation.
    const plan = call.args.selector === '#entry' && /\/jobs\/[135]$/.test(page.url()) ? [call, call] : [call];
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: plan.map(item => ({ id: `e2e-${++turn}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) } }] });
  }) as typeof fetch;
  const authoredLetter = 'Dear employer,\n\nI am interested in this developer role — I build reliable software.\n\nFixture Applicant';
  const letter = cleanCoverLetter(authoredLetter);
  const fill = (text = authoredLetter) => [
    { name: 'browser_action', args: { action: 'fill', selector: '#name', value: 'Fixture Applicant' } },
    { name: 'browser_action', args: { action: 'fill', selector: '#availability', value: 'Two weeks' } },
    { name: 'browser_action', args: { action: 'fill', selector: '#letter', value: text } },
    { name: 'browser_action', args: { action: 'set_input_files', selector: '#cv', file_ids: ['cv'] } },
    { name: 'prepare_application', args: { submit_selector: '#send', resume_id: 'cv', cover_letter: text, answers: [{ question: 'Name', answer: 'Fixture Applicant' }, { question: 'Availability', answer: 'Two weeks' }] } },
  ];
  const fixtures = Array.from({ length: 5 }, (_, index) => ({ ...job, id: String(index + 1), title: `Prepared Role ${index + 1}`, company: 'Fixture Employer', url: `https://listing.fixture.invalid/jobs/${index + 1}` }));
  for (const fixture of fixtures) {
    process.env.APPLICATION_REVIEW_MODE = 'prepare';
    await page.goto(fixture.url);
    calls = [{ name: 'browser_action', args: { action: 'click', selector: '#entry', sends_application: false } }, ...fill()];
    const result = await runAgentOnlyApplication({ page, job: fixture, profile, log: () => {} });
    assert.equal(result.outcome.status, 'prepared', `${fixture.title} is filled and held for review`);
    assert.ok(result.outcome.status === 'prepared');
    assert.equal(result.submitPressed, false);
    assert.equal(submissions.length, 0, 'preparing five applications never sends any of them');
    assert.equal(calls.length, 0);
    assert.equal(page.context().pages().length, Number(fixture.id) % 2 ? 2 : 1, 'popup forms open once and are followed without another Apply click or model tab-selection turn');
    assert.deepEqual(await page.context().pages().at(-1)!.locator('#cv').evaluate(node => [...(node as HTMLInputElement).files!].map(file => file.name)), ['Fixture CV.txt'], 'the real offered upload tool attaches the selected CV before preparation');
    const draft = result.outcome.draft;
    assert.ok(draft.answers.some(answer => answer.question === 'Availability' && answer.answer === 'Two weeks'));
    assert.equal(draft.coverLetter, letter);
    assert.equal(draft.answers.some(answer => answer.answer.includes('\u2014')), false);
    assert.equal(draft.resumeId, 'cv');
    assert.ok(draft.resumeHash);
    drafts.push(draft);
    for (const tab of page.context().pages()) if (tab !== page) await tab.close();
  }
  const beforeEdit = drafts[0].revision;
  drafts[0] = withCoverLetter(drafts[0], 'Dear team,\n\nThis is my edited cover letter — please use my exact wording.\n\nFixture Applicant');
  assert.notEqual(drafts[0].revision, beforeEdit, 'editing the letter invalidates the earlier review');
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify(drafts));
  process.env.APPLICATION_REVIEW_MODE = 'approved';
  // Use the production worker handoff: the last completed review publishes a
  // candidate and reports exhaustion together (the live one-job failure).
  const ready: typeof fixtures = [];
  let reviewed = 0;
  let attempted = 0;
  for (;;) {
    const fixture = await nextApplicationCandidate(() => ready.shift(), () => reviewed === fixtures.length, async () => {
      ready.push(fixtures[reviewed++]);
      return reviewed < fixtures.length;
    });
    if (!fixture) break;
    const index = fixtures.indexOf(fixture);
    attempted++;
    expectedApproved = drafts[index];
    await page.goto(drafts[index].formUrl);
    const rewritten = 'MODEL_REWRITE_MUST_NOT_REPLACE_THE_APPROVED_LETTER';
    const writes: typeof calls = fill(index < 2 ? rewritten : drafts[index].coverLetter);
    if (index === 1) writes[2] = { name: 'browser_batch', args: { actions: [{ action: 'fill', selector: '#letter', value: rewritten }] } };
    calls = [...writes, { name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } },
      { name: 'finish', args: { status: 'applied', reason: 'Fixture accepted', evidence: 'Application received', receipt: { quote: 'Application received' }, cover_letter: rewritten } }];
    if (index === 4) calls = [
      { name: 'prepare_application', args: { submit_selector: '#send', answers: [], resume_id: 'cv' } },
      { name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } },
      { name: 'finish', args: { status: 'applied', reason: 'Fixture accepted', evidence: 'Application received', receipt: { quote: 'Application received' }, answers: [] } },
    ];
    const result = await runAgentOnlyApplication({ page, job: fixture, profile, log: () => {} });
    assert.equal(result.outcome.status, 'applied');
    assert.equal(result.coverLetter, drafts[index].coverLetter, 'a model cannot rewrite the approved letter in the result audit');
    assert.ok(result.captured.some(answer => answer.question === 'Availability' && answer.answer === 'Two weeks'), 'earlier approved answers survive a resumed review and an abbreviated finish');
    assert.equal(calls.length, 0);
  }
  assert.equal(attempted, 5, 'the worker must drain all five approved jobs, including the final settled review');
  assert.deepEqual(submissions, ['1', '2', '3', '4', '5'], 'each unchanged confirmed application sends exactly once');
  assert.deepEqual(sentLetters, drafts.map(draft => draft.coverLetter), 'the actual posted forms preserve every approved letter, including the user edit');
  assert.equal(sentLetters.some(text => text.includes('\u2014')), false, 'no submitted cover letter contains an em dash');
  changedReview = true;
  expectedApproved = drafts[4];
  await page.goto(drafts[4].formUrl);
  calls = [{ name: 'prepare_application', args: { submit_selector: '#send', answers: [], resume_id: 'cv' } }];
  const changedSaved = await runAgentOnlyApplication({ page, job: fixtures[4], profile, log: () => {} });
  assert.equal(changedSaved.outcome.status, 'prepared', 'retaining earlier answers must never hide a changed actual saved value');
  assert.ok(changedSaved.outcome.status === 'prepared');
  assert.ok(changedSaved.outcome.draft.answers.some(answer => answer.question === 'Availability' && answer.answer === 'Three weeks'));
  assert.equal(submissions.length, 5, 'a changed saved review cannot send under the previous approval');
  const reportDir = resolve(import.meta.dirname, '../../output');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'semi-auto-e2e.json'), JSON.stringify({ prepared: drafts, submissions }, null, 2));
  console.log('PASS: five applications opened via listing links (including popups), filled, uploaded and prepared with zero sends; all five exact approved versions then submitted to isolated fixture forms.');
  console.log('PASS: Semi auto cannot send without confirmation; changed answers, target URLs and resume bytes invalidate approval.');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-application-review-'));
  rmSync(directory, { recursive: true, force: true });
}
