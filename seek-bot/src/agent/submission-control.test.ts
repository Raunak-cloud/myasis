import { createReadinessFixtureReply } from './readiness-fixture.js';
const readinessFixtureReply = createReadinessFixtureReply();
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium, type Page } from 'patchright';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';
import type { PreparedApplication } from '../application-review-types.js';
import { reviewContentFingerprint, reviewContextFingerprint } from '../review-cache.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-login-review-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.COST_TRACKING = 'false';
process.env.FORM_CORPUS_DIR = join(directory, 'corpus');
process.env.APPLICATION_REVIEW_MODE = 'prepare';
process.env.SITE_AUTH_SECRET = 'fixture-only';
process.env.CELERIS_QUEUE_FILE = join(directory, 'queue.sqlite');
process.env.CELERIS_MIN_INTERVAL_MS = '0';
const { config } = await import('../config.js');
const { runAgentOnlyApplication } = await import('./agent-only.js');
config.dryRun = false;
config.allowExternalApply = true;
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), 'Fixture applicant CV');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fixture CV', fileName: 'Fixture CV.txt' }]));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const originalFetch = globalThis.fetch;
type Call = { name: string; args: Record<string, unknown> };
const profile = { name: 'Fixture Applicant', email: 'fixture@example.invalid', phone: '', skills: [] } as never;
let page: Page;
let calls: Call[] = [];
let counter = 0;
let authPosts = 0;
let applicationPosts = 0;
const drafts: PreparedApplication[] = [];
let closeObservedReceipt = false;
let normalTools: string[] | undefined;
let checkpointWrongReplies = 0;
let checkpointRequests = 0;
let checkpointCompleteNext = false;
const jobs = Array.from({ length: 5 }, (_, index) => ({ id: `auth-${index}`, title: 'Developer', company: 'Fixture Employer',
  location: 'Sydney', platform: 'workday' as const, url: `https://employer.fixture.invalid/login/${index}` }));
const login = (id: string) => `<main><h1>Developer application</h1><h2>Sign In</h2>
  <form id="login" method="post" action="/review/${id}"><label>Email<input type="email" value="fixture@example.invalid"></label>
  <label>Password<input id="password" type="password" value="DO_NOT_EXPOSE_FIXTURE_PASSWORD"></label>
  <div id="overlay" role="button" tabindex="0" aria-label="Submit" onclick="document.querySelector('form').requestSubmit()">Sign In</div>
  <button aria-hidden="true" tabindex="-2" style="position:absolute;left:-5000px">Sign In</button></form></main>`;
const review = `<main><h1>Review application</h1><form method="post" action="/receipt">
  <label>Name<input id="name" name="name" required value="Fixture Applicant"></label>
  <label>Location<input id="city" role="combobox" aria-expanded="true" aria-controls="cities" aria-activedescendant="sydney"
    onkeydown="if(event.key==='Enter'){event.preventDefault();this.value='Sydney';this.setAttribute('aria-expanded','false')}" value="Sydney"></label>
  <div id="cities" role="listbox"><div id="sydney" role="option">Sydney</div></div>
  <input type="file" id="cv"><button id="send">Submit</button></form></main>`;
globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body));
    const reviewReply = readinessFixtureReply(body); if (reviewReply) return reviewReply;
  assert.ok(body.tools?.length, 'no independent submission classifier or receipt reviewer may be called');
  const offered: string[] = body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort();
  const forced = body.tool_choice?.function?.name;
  if (forced) {
    assert.deepEqual(offered, [forced], 'a reasoning checkpoint advertises only the already required record tool');
    checkpointRequests++;
    assert.equal(body.chat_template_kwargs.reasoning_effort, 'xhigh');
    assert.match(JSON.stringify(body.messages.at(-1)), /RECOVERY CHECKPOINT/);
    const wrong = checkpointWrongReplies-- > 0;
    const complete = forced === 'record_recovery_result' && checkpointCompleteNext;
    const args = forced === 'record_recovery_plan' ? {
      observed_issue: 'Two browser scripts failed; City is still empty.', evidence: ['City is empty in the current form.'],
      previous_approaches: ['The previous browser scripts raised fixture errors.'],
      next_action: 'Fill the observed City input with Sydney.', verification: 'The current City input reads Sydney.',
    } : complete ? { assessment: 'complete', evidence: ['Application received RECOVERY-002 is visible on the employer page.'],
      receipt_quote: 'Application received RECOVERY-002', next_action: 'Record the observed employer receipt.' }
      : { assessment: 'progress', evidence: ['City now reads Sydney in the fresh browser observation.'], next_action: 'Submit the completed application and inspect its receipt.' };
    if (complete) checkpointCompleteNext = false;
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `checkpoint-${++counter}`, type: 'function',
      function: { name: wrong ? 'browser_action' : forced, arguments: JSON.stringify(wrong ? { action: 'script', script: 'window.unexpectedCheckpointActions=1; return true' } : args) } }] } }],
      ...(complete ? { usage: { prompt_tokens: 0, completion_tokens: 10_000_000 } } : {}) });
  }
  const sharedTools = offered.filter(name => name !== 'prepare_application'); // Semi auto alone offers preparation.
  normalTools ??= sharedTools;
  assert.deepEqual(sharedTools, normalTools, 'normal tools return after each checkpoint and remain available after a send');
  for (const name of ['browser_action', 'browser_batch', 'take_snapshot', 'reason_through_problem', 'consult_application_specialist', 'save_progress']) assert.ok(offered.includes(name), `${name} remains available after a send`);
  assert.ok(!offered.includes('resume_after_rejected_submission'), 'there is no recovery-unlock tool');
  const call = calls.shift();
  assert.ok(call, `planned browser flow must complete without a workaround or human intervention; last result: ${body.messages.filter((item: { role: string }) => item.role === 'tool').at(-1)?.content?.slice(0, 1200)}`);
  if (closeObservedReceipt && call.name === 'finish') {
    assert.match(JSON.stringify(body.messages.at(-1)), /Receipt AUTO-001/, 'the applying agent observed the actual employer receipt');
    await page.setContent('<main>Candidate home. No more tasks.</main>');
    closeObservedReceipt = false;
  }
  return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${++counter}`, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
}) as typeof fetch;
try {
  for (const [index, job] of jobs.entries()) {
    const context = await browser.newContext();
    page = await context.newPage();
    const framed = index >= 3;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!url.hostname.endsWith('.invalid')) return route.abort();
      if (url.pathname === '/receipt') { applicationPosts++; return route.fulfill({ contentType: 'text/html', body: '<main>Application received</main>' }); }
      if (url.pathname.startsWith('/review/')) { authPosts++; return route.fulfill({ contentType: 'text/html', body: review }); }
      const content = framed && url.pathname.startsWith('/login/')
        ? `<main><h1>Employer careers</h1><iframe id="employer" src="https://embedded.fixture.invalid/auth/${index}" style="width:800px;height:600px"></iframe></main>`
        : login(String(index));
      return route.fulfill({ contentType: 'text/html', body: content });
    });
    await page.goto(job.url);
    const scope = framed ? page.frameLocator('#employer') : page;
    const at = (value: string) => ({ locator: { by: 'css', value, ...(framed ? { frame: '#employer' } : {}) } });
    if (index === 2 || index === 4) await scope.locator('#password').focus();
    const authAction = index === 0 || index === 3 ? { action: 'click', ...at('#overlay') }
      : { action: 'press', value: 'Enter', ...(index === 1 ? at('#password') : {}) };
    const unapprovedSend = index === 0 ? { action: 'click', ...at('#send') }
      : { action: 'press', value: index === 3 ? 'Space' : index === 4 ? 'NumpadEnter' : 'Enter', ...(index === 1 || index === 3 ? at('#send') : index === 2 ? at('#name') : {}) };
    calls = [
      { name: 'browser_action', args: { ...authAction, sends_application: false } },
      { name: 'browser_action', args: { action: 'click', ...at('#city'), sends_application: false } },
      { name: 'browser_action', args: { action: 'press', ...at('#city'), value: 'Enter', sends_application: false } },
      { name: 'browser_action', args: { action: 'set_input_files', ...at('#cv'), file_ids: ['cv'] } },
      { name: 'save_progress', args: { note: 'Selected fixture CV verified.', resume_id: 'cv' } },
      ...(index === 4 ? [{ name: 'browser_action', args: { action: 'press', ...at('#name'), value: 'Home', sends_application: false } }] : []),
      { name: 'browser_action', args: { ...unapprovedSend, sends_application: true } },
    ];
    const prepared = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
    assert.equal(prepared.outcome.status, 'prepared', `login flow ${index} reaches the completed form`);
    assert.ok(prepared.outcome.status === 'prepared');
    assert.equal(authPosts, index + 1, 'the authentication POST is permitted');
    assert.equal(applicationPosts, index, 'the unapproved final POST is withheld');
    assert.equal(prepared.submitPressed, false, 'authentication and widget activation are not application submissions');
    assert.equal(await scope.locator('#city').getAttribute('aria-expanded'), 'false', 'Enter selects a dropdown option');
    assert.equal(calls.length, 0);
    drafts.push(prepared.outcome.draft);
    writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify(drafts));
    process.env.APPLICATION_REVIEW_MODE = 'approved';
    // Keyboard submission, including focus in an iframe, must use precisely
    // the same content approval as a mouse click.
    if (index === 2 || index === 4) await scope.locator('#name').focus();
    const sendAction = index === 0 ? { action: 'click', ...at('#send') }
      : { action: 'press', value: index === 4 ? 'NumpadEnter' : 'Enter', ...(index === 1 ? at('#send') : index === 3 ? at('#name') : {}) };
    calls = [
      { name: 'browser_action', args: { action: 'set_input_files', ...at('#cv'), file_ids: ['cv'] } },
      { name: 'save_progress', args: { note: 'Approved fixture CV verified.', resume_id: 'cv' } },
      { name: 'browser_action', args: { ...sendAction, sends_application: true } },
      { name: 'finish', args: { status: 'applied', reason: 'Fixture accepted', evidence: 'Application received', receipt: { quote: 'Application received' } } },
    ];
    const sent = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
    assert.equal(sent.outcome.status, 'applied');
    assert.equal(applicationPosts, index + 1, 'only the confirmed application can be posted');
    assert.equal(calls.length, 0);
    process.env.APPLICATION_REVIEW_MODE = 'prepare';
    await context.close();
  }
  delete process.env.APPLICATION_REVIEW_MODE;
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main>Fictional application</main>' }));
  page = await context.newPage();
  await page.goto('https://employer.fixture.invalid/auto');
  const autoJob = { ...jobs[0], id: 'agent-owned-auto', url: page.url() };
  await page.setContent(`<main><form onsubmit="event.preventDefault();window.sends++;document.querySelector('main').innerHTML='<h1>Application received</h1><p>Receipt AUTO-001</p>'">
    <label>City<input id=city required></label><button>Submit application</button></form></main>`);
  await page.evaluate('window.sends=0', undefined, undefined, false);
  closeObservedReceipt = true;
  calls = [
    { name: 'browser_action', args: { action: 'click', selector: '#city' } },
    { name: 'browser_action', args: { action: 'fill', selector: '#city', value: 'Sydney' } },
    { name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } },
    { name: 'finish', args: { status: 'applied', reason: 'Observed employer receipt', evidence: 'Application received. Receipt AUTO-001', receipt: { quote: 'Receipt AUTO-001' } } },
  ];
  const auto = await runAgentOnlyApplication({ page, job: autoJob, profile, log: () => {} });
  assert.equal(auto.outcome.status, 'applied', 'agent receipt judgement survives an employer receipt disappearing after observation');
  assert.equal(auto.submitPressed, true);
  assert.equal(await page.evaluate('window.sends', undefined, undefined, false), 1);
  assert.equal(calls.length, 0, 'ordinary location clicks did not restrict subsequent filling');

  await page.setContent(`<main><form onsubmit="event.preventDefault();window.correctedSends++;document.querySelector('main').textContent='Submitted'">
    <label>Required city<input id=city required></label><button>Submit application</button></form></main>`);
  await page.evaluate('window.correctedSends=0', undefined, undefined, false);
  calls = [
    { name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } },
    { name: 'browser_action', args: { action: 'fill', selector: '#city', value: 'Sydney' } },
    { name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } },
    { name: 'finish', args: { status: 'applied', reason: 'Employer received corrected form', evidence: 'The employer returned Submitted after receiving the corrected form.', receipt: { quote: 'Submitted' } } },
  ];
  const corrected = await runAgentOnlyApplication({ page, job: { ...autoJob, id: 'agent-owned-correction' }, profile, log: () => {} });
  assert.equal(corrected.outcome.status, 'applied');
  assert.equal(await page.evaluate('window.correctedSends', undefined, undefined, false), 1, 'agent-directed recovery submits only the corrected valid form');
  assert.equal(calls.length, 0);

  await page.setContent(`<main><button onclick="window.pendingSends++;this.disabled=true;this.textContent='Please wait...'">Submit application</button></main>`);
  await page.evaluate('window.pendingSends=0', undefined, undefined, false);
  calls = [
    { name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } },
    { name: 'finish', args: { status: 'skipped', reason: 'Employer delivery remains unconfirmed', evidence: 'The button only says Please wait...' } },
  ];
  const pending = await runAgentOnlyApplication({ page, job: { ...autoJob, id: 'agent-owned-pending' }, profile, log: () => {} });
  assert.equal(pending.outcome.status, 'skipped');
  assert.equal(pending.submitPressed, true, 'an uncertain send is retained for duplicate protection');
  assert.equal(await page.evaluate('window.pendingSends', undefined, undefined, false), 1);
  assert.equal(calls.length, 0);
  await page.setContent('<main>Employer application facts have changed.</main>');
  const reviewedJob = { ...autoJob, id: 'agent-owned-skip', description: 'Matched original duties.' };
  calls = [{ name: 'finish', args: { status: 'skipped', reason: 'The applying agent decided to stop.',
    evidence: 'Agent-observed evidence.', fit_rejection: { source: 'listing', evidence: 'Matched original duties.' } } }];
  const agentSkip = await runAgentOnlyApplication({ page, job: { ...reviewedJob, fitReview: {
    score: 90, reason: 'Prior match.', evidence: ['Matched original duties.'],
    contentFingerprint: reviewContentFingerprint(reviewedJob)!, contextFingerprint: reviewContextFingerprint(profile),
  } }, profile, log: () => {} });
  assert.equal(agentSkip.outcome.status, 'skipped', 'Owtomate accepts the applying agent judgment without a semantic veto.');
  assert.equal(calls.length, 0);
  await page.setContent(`<main><h1>Recovery fixture</h1><form onsubmit="event.preventDefault();document.querySelector('main').textContent='Application received RECOVERY-001'">
    <label>City<input id=city required></label><button>Submit application</button></form></main>`);
  checkpointWrongReplies = 1;
  const beforeCheckpoints = checkpointRequests;
  calls = [
    { name: 'browser_action', args: { action: 'script', script: "throw new Error('Fixture failed approach one')" } },
    { name: 'browser_action', args: { action: 'script', script: "throw new Error('Fixture failed approach two')" } },
    { name: 'browser_action', args: { action: 'fill', selector: '#city', value: 'Sydney' } },
    { name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } },
    { name: 'finish', args: { status: 'applied', reason: 'Observed employer receipt', evidence: 'Application received RECOVERY-001', receipt: { quote: 'Application received RECOVERY-001' } } },
  ];
  const recovered = await runAgentOnlyApplication({ page, job: { ...autoJob, id: 'checkpoint-correction' }, profile, log: () => {} });
  assert.equal(recovered.outcome.status, 'applied');
  assert.equal(checkpointRequests - beforeCheckpoints, 3, 'one rejected plan, corrected plan and result check');
  assert.equal(await page.evaluate('window.unexpectedCheckpointActions || 0', undefined, undefined, false), 0, 'wrong named-tool response never executes a browser action');
  assert.equal(calls.length, 0);

  await page.setContent('<main><label>City<input id=city></label></main>');
  checkpointWrongReplies = 2;
  calls = [
    { name: 'browser_action', args: { action: 'script', script: "throw new Error('Fixture failed approach one')" } },
    { name: 'browser_action', args: { action: 'script', script: "throw new Error('Fixture failed approach two')" } },
    { name: 'browser_action', args: { action: 'fill', selector: '#city', value: 'Sydney' } },
    { name: 'finish', args: { status: 'skipped', reason: 'Fixture completed its correction without a submission.', evidence: 'City reads Sydney.' } },
  ];
  const rejectedCheckpoint = await runAgentOnlyApplication({ page, job: { ...autoJob, id: 'checkpoint-invalid' }, profile, log: () => {} });
  assert.equal(rejectedCheckpoint.outcome.status, 'skipped');
  assert.equal(await page.locator('#city').inputValue(), 'Sydney', 'normal actions resume after malformed checkpoint responses');
  assert.equal(await page.evaluate('window.unexpectedCheckpointActions || 0', undefined, undefined, false), 0);
  assert.equal(calls.length, 0);
  await page.setContent(`<main><label>City<input id=city></label><button onclick="document.querySelector('main').textContent='Application received RECOVERY-002'">Submit application</button></main>`);
  checkpointWrongReplies = 0;
  checkpointCompleteNext = true;
  calls = [
    { name: 'browser_action', args: { action: 'script', script: "throw new Error('Fixture failed approach one')" } },
    { name: 'browser_action', args: { action: 'script', script: "throw new Error('Fixture failed approach two')" } },
    { name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: true } },
  ];
  const finalRecoveryReceipt = await runAgentOnlyApplication({ page, job: { ...autoJob, id: 'checkpoint-budget-receipt' }, profile, log: () => {} });
  assert.equal(finalRecoveryReceipt.outcome.status, 'applied', 'a recovery-result reply that crosses the budget retains the observed receipt');
  assert.equal(calls.length, 0);
  await context.close();
  console.log('PASS: agent-owned classification and receipts; five Semi auto login/widget/approval flows, Auto location entry, transient receipt, agent-directed correction and uncertain-send audit. No secondary model requests or real applications.');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  closeCelerisQueues();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-login-review-'));
  rmSync(directory, { recursive: true, force: true });
}
