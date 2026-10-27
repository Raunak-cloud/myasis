import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'patchright';
import type { PreparedApplication } from '../application-review-types.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-login-review-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.COST_TRACKING = 'false';
process.env.FORM_CORPUS_DIR = join(directory, 'corpus');
process.env.APPLICATION_REVIEW_MODE = 'prepare';
process.env.SITE_AUTH_SECRET = 'fixture-only';
const { config } = await import('../config.js');
const { runAgentOnlyApplication } = await import('./agent-only.js');
const { submissionControl } = await import('./submission-control.js');
config.dryRun = false;
config.allowExternalApply = true;
config.celeris.maxSteps = 10;
config.celeris.progressMaxSteps = 10;
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
let classifierCalls = 0;
let phase: 'login' | 'widget' | 'application' = 'login';
const drafts: PreparedApplication[] = [];
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
  if (!body.tools?.length) {
    classifierCalls++;
    const prompt = JSON.stringify(body.messages);
    assert.match(prompt, /Signing in, creating an account/);
    assert.ok(!prompt.includes('DO_NOT_EXPOSE_FIXTURE_PASSWORD'), 'control metadata never contains a password');
    if (phase === 'login') { assert.match(prompt, /password/); assert.match(prompt, /Sign In/); }
    if (phase === 'widget') assert.match(prompt, /combobox/);
    return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ sends_application: phase === 'application' }) } }] });
  }
  const call = calls.shift();
  assert.ok(call, `planned browser flow must complete without a workaround or human intervention; last result: ${body.messages.filter((item: { role: string }) => item.role === 'tool').at(-1)?.content?.slice(0, 1200)}`);
  phase = call.args.test_phase as typeof phase ?? phase;
  delete call.args.test_phase;
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
    const authTarget = scope.locator('#overlay');
    const facts = await submissionControl(page, authTarget);
    assert.equal(facts.label, 'Submit');
    assert.ok(facts.context.includes('password'));
    assert.ok(!facts.context.includes('DO_NOT_EXPOSE_FIXTURE_PASSWORD'));
    if (index === 2 || index === 4) await scope.locator('#password').focus();
    const authAction = index === 0 || index === 3 ? { action: 'click', ...at('#overlay') }
      : { action: 'press', value: 'Enter', ...(index === 1 ? at('#password') : {}) };
    const unapprovedSend = index === 0 ? { action: 'click', ...at('#send') }
      : { action: 'press', value: index === 3 ? 'Space' : index === 4 ? 'NumpadEnter' : 'Enter', ...(index === 1 || index === 3 ? at('#send') : index === 2 ? at('#name') : {}) };
    calls = [
      { name: 'browser_action', args: { ...authAction, test_phase: 'login' } },
      { name: 'browser_action', args: { action: 'press', ...at('#city'), value: 'Enter', test_phase: 'widget' } },
      { name: 'upload_document', args: { ...at('#cv'), document_id: 'cv' } },
      ...(index === 4 ? [{ name: 'browser_action', args: { action: 'press', ...at('#name'), value: 'Home' } }] : []),
      { name: 'browser_action', args: { ...unapprovedSend, test_phase: 'application' } },
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
      { name: 'upload_document', args: { ...at('#cv'), document_id: 'cv' } },
      { name: 'browser_action', args: { ...sendAction, test_phase: 'application' } },
      { name: 'finish', args: { status: 'applied', reason: 'Fixture accepted', evidence: 'Application received' } },
    ];
    const sent = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
    assert.equal(sent.outcome.status, 'applied');
    assert.equal(applicationPosts, index + 1, 'only the confirmed application can be posted');
    assert.equal(calls.length, 0);
    process.env.APPLICATION_REVIEW_MODE = 'prepare';
    await context.close();
  }
  assert.equal(classifierCalls, 20, 'all authentication, widget and final actions use contextual classification');
  const metadataPage = await browser.newPage();
  await metadataPage.setContent(`<main><form id="signin"><h2>Sign In</h2><label>Password<input type="password" value="DO_NOT_EXPOSE_FIXTURE_PASSWORD"></label></form>
    <button id="auth-submit" form="signin">Submit</button>
    <form id="application"><h2>Review application</h2><label>Cover letter<textarea>Fixture letter</textarea></label><button id="final-submit">Submit</button></form></main>`);
  const authContext = JSON.parse((await submissionControl(metadataPage, metadataPage.locator('#auth-submit'))).context);
  const finalContext = JSON.parse((await submissionControl(metadataPage, metadataPage.locator('#final-submit'))).context);
  assert.equal(authContext.fields.length, 1, 'a form-associated external button retains its own form context');
  assert.equal(authContext.fields[0].type, 'password');
  assert.equal(finalContext.fields.length, 1, 'a nearby sign-in form cannot misclassify the final application');
  assert.equal(finalContext.fields[0].tag, 'TEXTAREA');
  console.log('PASS: five native login flows, including Submit overlays, Enter and iframe focus, reach prepared applications without sending; five exact approvals then submit through click/keyboard.');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
