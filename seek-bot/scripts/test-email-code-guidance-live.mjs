// Real MiniMax with an isolated employer and an in-memory mailbox adapter.
// No access to real email accounts, employers or candidate data.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';

if (!process.argv.includes('--live')) throw Error('Pass --live to use the configured MiniMax API with fictional email.');
const directory = mkdtempSync(join(tmpdir(), 'owtomate-email-code-guidance-'));
Object.assign(process.env, {
  APPLICATION_AI_MODEL: 'minimax', DATA_DIR: directory, DRY_RUN: 'true', COST_TRACKING: 'false',
  ALLOW_EXTERNAL_APPLY: 'true', APPLICATION_REVIEW_MODE: '', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false',
  RESUME_SELECT: 'fixture-cv', FORM_CORPUS_DIR: join(directory, 'corpus'), KEYWORDS: 'data analyst', TARGET_ROLE: '',
  COVER_LETTER_MODE: 'tailored', COVER_LETTER_TEXT_B64: '', COVER_LETTER_INSTRUCTIONS: '', AI_INSTRUCTIONS_B64: '',
  AGENT_BUDGET_USD: '0.15', AGENT_PROGRESS_BUDGET_USD: '0.30',
});
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), 'Alex Fixture. Data Analyst. SQL and Power BI. Sydney, Australia. Australian citizen.');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'fixture-cv', label: 'Fixture CV', fileName: 'Fixture CV.txt', isDefault: true }]));
const { GmailMcpService } = await import('../dist/gmail-mcp-service.js');
const state = { requested: 0, mailboxReads: 0, accepted: 0, verifyPosts: 0 };
const code = '753819', unrelatedCode = '628731';
const gateway = new GmailMcpService({
  search: async () => { assert.ok(state.requested, 'The employer must request verification before a mailbox read'); state.mailboxReads++; return [{ id: 'fixture-thread' }]; },
  thread: async () => [
    { id: 'unrelated', sender: 'noreply@unrelated.invalid', subject: 'Unrelated Employer verification code', date: new Date().toISOString(), plaintextBody: `Your verification code is ${unrelatedCode}.` },
    { id: 'matching', sender: 'noreply@employer.fixture.invalid', subject: 'Fictional Employer: verify your application email', date: new Date().toISOString(), plaintextBody: `Your Fictional Employer email verification code is ${code}. This code expires in 10 minutes.` },
  ],
  send: async () => { throw Error('Sending email is unavailable in this fixture'); },
});
const lease = await gateway.grant('fixture-owner', 'alex@example.invalid');
Object.assign(process.env, { GMAIL_MCP_URL: lease.connection.url, GMAIL_MCP_TOKEN: lease.connection.token, GMAIL_MCP_ACCOUNT: lease.connection.account, GMAIL_ACCESS_MODE: 'mcp' });
const { config } = await import('../dist/config.js');
const { runApplicationAgent } = await import('../dist/agent/loop.js');
const { applicationAgentIdentity } = await import('../dist/application-model.js');
assert.equal(config.dryRun, true);
assert.equal(applicationAgentIdentity().selection, 'minimax');
if (!process.env.OPENROUTER_API_KEY) throw Error('OPENROUTER_API_KEY is not configured.');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch, codeCalls = [];
let requests = 0, summary;
const receipt = 'Application received for Alex Fixture: Data Analyst at Fictional Employer. Receipt EMAIL-GUIDANCE-123.';
const started = Date.now();
try {
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'employer.fixture.invalid') return route.abort();
    if (url.pathname === '/request-code' && request.method() === 'POST') {
      state.requested++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: 'We emailed a verification code to alex@example.invalid. Enter it below, then Verify and submit application.' }) });
    }
    if (url.pathname === '/verify' && request.method() === 'POST') {
      state.verifyPosts++;
      const entered = JSON.parse(request.postData() || '{}').code;
      if (state.requested && entered === code) { state.accepted++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted: true, message: receipt }) }); }
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Incorrect verification code. Application not submitted.' }) });
    }
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><main><h1>Data Analyst at Fictional Employer</h1><p>Application for Alex Fixture. Sydney.</p><p id=message>Verify your email to submit this application.</p>
<button id=request type=button onclick="requestCode()">Email me a verification code</button><section id=verification hidden><label>Verification code<input id=code inputmode=numeric autocomplete=one-time-code maxlength=6></label><button id=verify type=button onclick="verify()">Verify and submit application</button></section></main>
<script>async function requestCode(){const data=await(await fetch('/request-code',{method:'POST'})).json();document.querySelector('#message').textContent=data.message;document.querySelector('#verification').hidden=false;document.querySelector('#request').hidden=true;}
async function verify(){const data=await(await fetch('/verify',{method:'POST',body:JSON.stringify({code:document.querySelector('#code').value})})).json();if(data.accepted)document.querySelector('main').innerHTML='<h1>'+data.message+'</h1>';else document.querySelector('#message').textContent=data.message;}</script>` });
  });
  const page = await context.newPage(), url = 'https://employer.fixture.invalid/apply';
  await page.goto(url);
  globalThis.fetch = async (input, init) => {
    const target = new URL(String(input));
    assert.ok(target.hostname === 'openrouter.ai' || target.origin === new URL(lease.connection.url).origin, 'Only the model and the in-memory mailbox gateway are reachable');
    if (target.hostname !== 'openrouter.ai') return originalFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.tools?.length) {
      requests++;
      assert.equal(body.model, applicationAgentIdentity().model);
      assert.equal(body.reasoning?.effort, 'high');
      for (const secret of [code, unrelatedCode]) assert.ok(!JSON.stringify(body.messages).includes(secret), 'Private code values must not reach the model');
    }
    const response = await originalFetch(input, init);
    if (response.ok && body.tools?.length) {
      const payload = await response.clone().json();
      for (const call of payload.choices?.[0]?.message?.tool_calls ?? []) if (call.function?.name === 'enter_emailed_code') {
        const args = JSON.parse(call.function.arguments);
        codeCalls.push({ hasTargets: Boolean(args.ref || args.refs?.length || args.targets?.length), selected: Boolean(args.credential_id), purpose: args.purpose });
      }
    }
    return response;
  };
  const result = await runApplicationAgent({ page, simulation: 'isolated-form',
    job: { id: 'email-code-guidance', title: 'Data Analyst', company: 'Fictional Employer', location: 'Sydney', url, platform: 'smartrecruiters', source: 'chosen', applicationMode: 'external', description: 'Data Analyst using SQL and Power BI.' },
    profile: { name: 'Alex Fixture', email: 'alex@example.invalid', phone: '0400000000', nationality: 'Australian', workRights: 'Citizen', workRightsCountry: 'Australia', expectedSalary: 'AUD 135000', noticePeriod: 'Two weeks', willingToRelocate: false, skills: ['SQL', 'Power BI'], experienceSummary: 'Data Analyst in Sydney, Australia.', excludedDomains: [], securityClearance: 'None held' }, log: () => {} });
  assert.equal(state.requested, 1);
  assert.ok(state.mailboxReads > 0);
  assert.equal(state.verifyPosts, 1);
  assert.equal(state.accepted, 1);
  assert.equal(result.outcome.status, 'rehearsed');
  assert.equal(result.submitPressed, true);
  assert.ok(codeCalls.length >= 2, 'The actual model must inspect the messages and choose a returned credential');
  assert.equal(codeCalls[0].selected, false);
  assert.ok(codeCalls.some(call => call.selected));
  assert.ok(codeCalls.every(call => call.hasTargets), 'Every code call, including the first, must supply current code targets');
  assert.ok(codeCalls.every(call => call.purpose === 'account_verification'));
  assert.match(await page.locator('main').innerText(), /Receipt EMAIL-GUIDANCE-123/);
  summary = { passed: true, realEmployerSubmissions: 0, realMailboxReads: 0, model: applicationAgentIdentity().model, reasoning: 'high', requests, codeCalls, ...state, usage: result.usage, elapsedMs: Date.now() - started };
} catch (error) {
  process.exitCode = 1;
  summary = { passed: false, error: error.message, realEmployerSubmissions: 0, realMailboxReads: 0, requests, codeCalls, ...state, elapsedMs: Date.now() - started };
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  lease.revoke(); await gateway.close();
  mkdirSync(new URL('../output/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../output/email-code-guidance-live.json', import.meta.url), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-email-code-guidance-'));
  rmSync(directory, { recursive: true, force: true });
}
