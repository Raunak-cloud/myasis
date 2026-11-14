/** Real browser transport with scripted decisions; no real employer, mailbox or paid model calls. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';
import { fixtureToolArguments } from './specialist-fixture.js';
import { createReadinessFixtureReply } from './readiness-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-browser-recovery-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', APPLICATION_AI_MODEL: 'celeris',
 APPLICATION_REVIEW_MODE: 'prepare', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false',
 CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'), CELERIS_MIN_INTERVAL_MS: '0', COST_TRACKING: 'false',
 AGENT_BUDGET_USD: '0.40', AGENT_PROGRESS_BUDGET_USD: '1.00', OWTOMATE_LIVE_REPAIR: '' });
const { config } = await import('../config.js'); config.dryRun = true; config.allowExternalApply = true;
const { runAgentOnlyApplication } = await import('./agent-only.js');
mkdirSync(join(directory, 'resumes')); writeFileSync(join(directory, 'resumes/CV.txt'), 'Fictional candidate resume');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fixture CV', fileName: 'CV.txt' }]));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const fetchOriginal = globalThis.fetch;
type Call = { name: string; args: Record<string, unknown> };
const click = (selector: string, sends_application = false): Call => ({ name: 'browser_action', args: { action: 'click', selector, sends_application } });
const prepare: Call = { name: 'prepare_application', args: { answers: [], resume_id: 'cv', submit_selector: '#send' } };
const city: Call = { name: 'browser_action', args: { action: 'fill', selector: '#city', value: 'Sydney' } };
const waitForConsent: Call = { name: 'browser_action', args: { action: 'wait', selector: '#allow', state: 'visible' } };
const form = `<form id=form><label>City<input id=city required value=Sydney></label><button id=send type=button onclick="localStorage.setItem('sends',String(Number(localStorage.getItem('sends')||0)+1));document.body.innerHTML='<main><h1>Application received.</h1></main>'">Submit application</button></form>`;

async function scenario(id: string, body: string, calls: Array<Call | Call[]>, actualSend = false) {
 config.dryRun = true; process.env.APPLICATION_REVIEW_MODE = actualSend ? '' : 'prepare';
 const context = await browser.newContext(), page = await context.newPage();
 const url = `https://${id}.fixture.invalid/application`;
 await context.route('**/*', route => !new URL(route.request().url()).hostname.endsWith('.invalid') ? route.abort()
  : route.fulfill({ contentType: 'text/html', body: route.request().url().includes('/identity')
   ? `<main><h1>Sign-in consent</h1><button id=allow onclick="const status=window.opener.document.querySelector('#status');if(status)status.textContent='Signed in';window.close()">Allow</button></main>` : body }));
 await page.goto(url);
 let decisions = 0; const seen: string[] = [], readiness = createReadinessFixtureReply();
 globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(String(init?.body));
  assert.ok(!request.tools.some((t:any) => /specialist|consult_application/.test(t.function.name)));
  const guidance = readiness(request); if (guidance) return guidance;
  seen.push(request.messages.filter((m:any)=>m.role==='user').map((m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n'));
  const planned = calls[decisions++]; assert.ok(planned, `${id}: unexpected extra decision`);
  const callsForTurn = Array.isArray(planned) ? planned : [planned];
  if (actualSend) config.dryRun = false;
  return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ message: { role: 'assistant', content: null,
   tool_calls: callsForTurn.map((call,index) => ({ id: `${id}-${decisions}-${index}`, type: 'function', function: { name: call.name, arguments: fixtureToolArguments(request, call.name, call.args) } })) } }] });
 };
 try {
  const result = await runAgentOnlyApplication({ simulation: 'isolated-form', page,
   job: { id, title: 'Analyst', company: 'Fixture', location: 'Sydney', platform: 'workday', url },
   profile: { name: 'Fictional Candidate', email: 'fixture@example.invalid', suburb: 'Sydney', skills: [] } as never, log: () => {} });
  const trace = JSON.parse(readFileSync(join(directory, 'traces', `${id}.json`), 'utf8'));
  return { result, trace, seen, decisions, sends: await page.evaluate(() => Number(localStorage.getItem('sends') || 0)), emailWrites: await page.evaluate(() => Number(localStorage.getItem('email-writes') || 0)) };
 } finally { await context.close(); }
}

try {
 await test('missing target returns fresh entry controls and the agent can advance instead of quitting', async () => {
  const run = await scenario('missing-target', `<main><h1>Vacancy details</h1><button id=apply onclick="this.hidden=true;document.querySelector('#form').hidden=false">Apply</button><div id=status></div>${form.replace('<form id=form>', '<form id=form hidden>')}</main>`,
   [{ name: 'browser_action', args: { action: 'fill', selector: '#email', value: 'example' } }, click('#apply'), city, prepare]);
  assert.equal(run.result.outcome.status, 'prepared'); assert.equal(run.sends, 0);
  assert.ok(run.seen.some(text => /Inspect the current page, correct the target or change approach/i.test(text)));
 });
 await test('native action auto-waits beyond the old 15-second limit and submits exactly once', async () => {
  const delayed = form.replace('id=send type=button', 'id=send disabled type=button') + '<script>setTimeout(()=>document.querySelector("#send").disabled=false,16000)</script>';
  const run = await scenario('delayed-native-action', delayed, [click('#send', true),
   { name: 'finish', args: { status: 'applied', reason: 'Employer confirmation is visible.', evidence: 'Application received.', receipt: { quote: 'Application received.' } } }], true);
  assert.equal(run.result.outcome.status, 'applied'); assert.equal(run.sends, 1); assert.equal(run.decisions, 2);
 });
 await test('self-closing sign-in popup returns to the original saved form without another agent', async () => {
  const run = await scenario('popup-return', `<main><button id=login onclick="window.open('/identity','consent')">Sign in</button><div id=status></div>${form}</main>`,
   [click('#login'), waitForConsent, click('#allow'), city, prepare]);
  assert.equal(run.result.outcome.status, 'prepared'); assert.equal(run.sends, 0);
  assert.ok(run.seen.some(text => /tab closed|tab.*inspection/i.test(text)));
  assert.ok(run.result.captured.some(answer => answer.answer === 'Sydney'));
 });
 await test('a page displaying a verification challenge remains available for agent-chosen recovery', async () => {
  const run = await scenario('challenge-recovery', `<main><iframe src="https://newassets.hcaptcha.com/challenge" title="hCaptcha challenge"></iframe><button id=verify onclick="document.querySelector('iframe').remove()">Fixture verification complete</button><div id=status></div>${form}</main>`,
   [click('#verify'), city, prepare]);
  assert.equal(run.result.outcome.status, 'prepared'); assert.equal(run.sends, 0); assert.equal(run.decisions, 3);
 });
 await test('private filling reports already-correct values instead of rewriting them as supposed progress', async () => {
  const fill: Call = { name: 'fill_authentication_fields', args: { purpose: 'sign_in', reason:'The current form has an email field and a verification control.', targets: [{ selector: '#email' }] } };
  const run = await scenario('private-fill-feedback', `<main><label>Email<input id=email type=email value="fixture@example.invalid" oninput="localStorage.setItem('email-writes',String(Number(localStorage.getItem('email-writes')||0)+1))"></label><button id=verify type=button>Verify email to continue</button><div id=status></div>${form}</main>`,
   [fill, fill, city, prepare]);
  assert.equal(run.result.outcome.status, 'prepared');
  assert.ok(run.trace.steps.slice(0,2).every((step:any)=>/Already matched the requested candidate values/.test(step.result)),JSON.stringify(run.trace.steps.slice(0,2).map((s:any)=>s.result)));
  assert.ok(run.trace.steps[0].result.includes('Verify email to continue'));
  assert.ok(run.trace.steps.slice(0,2).every((step:any)=>step.disposition==='completed'));
  assert.equal(run.emailWrites, 0);
  const forced = await scenario('private-fill-native-events', `<main><label>Email<input id=email type=email value="fixture@example.invalid" oninput="localStorage.setItem('email-writes',String(Number(localStorage.getItem('email-writes')||0)+1))"></label><div id=status></div>${form}</main>`,
   [{...fill,args:{...fill.args,refill:true}},city,prepare]);
  assert.equal(forced.result.outcome.status,'prepared'); assert.ok(forced.emailWrites>0,'the agent can still choose a native refill when framework events are needed');
 });
 await test('already-correct private values let later evidence reads and form actions run in the same reply', async () => {
  const fill:Call={name:'fill_authentication_fields',args:{purpose:'sign_in',reason:'Observed candidate email',targets:[{selector:'#email'}]}};
  const run=await scenario('private-noop-continuation', `<main><label>Email<input id=email type=email value="fixture@example.invalid" oninput="localStorage.setItem('email-writes',String(Number(localStorage.getItem('email-writes')||0)+1))"></label>${form.replace('value=Sydney','')}</main>`,
   [[fill,{name:'read_candidate_evidence',args:{query:'Fictional'}},city],prepare]);
  assert.equal(run.result.outcome.status,'prepared');assert.equal(run.decisions,2);assert.equal(run.emailWrites,0);assert.equal(run.sends,0);
  assert.equal(run.trace.steps[0].disposition,'completed');
  assert.equal(run.trace.steps[1].tool,'read_candidate_evidence');assert.notEqual(run.trace.steps[1].disposition,'not-executed');
  assert.equal(run.trace.steps[2].tool,'browser_action');assert.notEqual(run.trace.steps[2].disposition,'not-executed');
  assert.ok(run.result.captured.some(answer=>answer.answer==='Sydney'));
 });
 await test('an actual private-fill error still stops later actions until the agent chooses recovery', async () => {
  const wrong:Call={name:'fill_authentication_fields',args:{purpose:'sign_in',reason:'Incorrect fixture target',targets:[{selector:'#cv'}]}};
  const run=await scenario('private-failure-pause', `<main><label>Resume<input id=cv type=file></label>${form.replace('value=Sydney','')}</main>`,[[wrong,city],city,prepare]);
  assert.equal(run.result.outcome.status,'prepared');assert.equal(run.decisions,3);assert.equal(run.sends,0);
  assert.equal(run.trace.steps[0].disposition,'failed');assert.equal(run.trace.steps[1].disposition,'not-executed');
  assert.equal(run.trace.steps[2].disposition,undefined);assert.ok(run.result.captured.some(answer=>answer.answer==='Sydney'));
 });
 await test('a sign-in popup closing after a possible send cannot cause an automatic duplicate submission', async () => {
  const body = `<main><div id=status></div>${form.replace("document.body.innerHTML=", "window.open('/identity','receipt');document.body.innerHTML=")}</main>`;
  // The consent popup closes; the receipt remains on the original application page.
  const run = await scenario('post-send-popup', body, [click('#send', true), waitForConsent, click('#allow'),
   { name: 'finish', args: { status: 'applied', reason: 'The employer receipt is visible.', evidence: 'Application received.', receipt: { quote: 'Application received.' } } }], true);
  assert.equal(run.result.outcome.status, 'applied'); assert.equal(run.sends, 1); assert.equal(run.result.submitPressed, true);
 });
 await test('wrong private tool selection returns usable native actions instead of unusable internal refs', async () => {
  const wrong:Call={name:'fill_authentication_fields',args:{purpose:'sign_in',reason:'The agent selected the wrong tool for the resume.',targets:[{selector:'#cv'}]}};
  const run = await scenario('wrong-tool-recovery', `<main><label>Resume<input id=cv type=file></label><div id=status></div>${form}</main>`,
   [wrong,wrong,city,prepare]);
  assert.equal(run.result.outcome.status,'prepared'); assert.equal(run.sends,0);
  assert.match(run.trace.steps[0].result,/browser_upload and file_ids/);
  assert.doesNotMatch(run.trace.steps[0].result,/private-native-0/);
  assert.ok(run.seen.some(text=>text.includes('previous')||text.includes('failedInteractions')),'observed failed attempts remain in application memory without a prescribed recovery flow');
 });
} finally { globalThis.fetch = fetchOriginal; await browser.close(); closeCelerisQueues(); rmSync(directory, { recursive: true, force: true }); }
