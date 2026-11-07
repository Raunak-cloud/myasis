import { isSpecialistFixtureRequest, fixtureToolArguments } from './specialist-fixture.js';
/** Real browser, isolated forms and scripted providers. No real mail, paid calls or applications. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';
import { withApplicationModel, MINIMAX_APPLICATION_MODEL } from '../application-model.js';
import { createReadinessFixtureReply } from './readiness-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'automatic-specialist-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', APPLICATION_AI_MODEL: 'celeris',
  APPLICATION_REVIEW_MODE: 'prepare', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false',
  CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'), CELERIS_MIN_INTERVAL_MS: '0', COST_TRACKING: 'false',
  AGENT_BUDGET_USD: '0.40', AGENT_PROGRESS_BUDGET_USD: '1.00',
  GMAIL_MCP_URL: 'https://mailbox.fixture.invalid', GMAIL_MCP_TOKEN: 'fixture-only', GMAIL_MCP_ACCOUNT: 'fixture@example.invalid', OWTOMATE_LIVE_REPAIR: '' });
const { config } = await import('../config.js'); config.dryRun = true; config.allowExternalApply = true;
const { runAgentOnlyApplication } = await import('./agent-only.js');
const { buildApplicationSystemPrompt } = await import('./application-policy.js');
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes/CV.txt'), 'Fictional resume');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fixture CV', fileName: 'CV.txt' }]));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const originalFetch = globalThis.fetch;
type Call = { name: string; args: Record<string, unknown> };
const click = (selector: string): Call => ({ name: 'browser_action', args: { action: 'click', selector, sends_application: false } });
const complete: Call[] = [click('#google'), { name: 'browser_action', args: { action: 'fill', selector: '#city', value: 'Sydney' } },
  { name: 'prepare_application', args: { answers: [], resume_id: 'cv', submit_selector: '#send' } }];
const html = `<main><h1>Fixture application sign in</h1><label>One-time code<input id=otp autocomplete=one-time-code></label>
  <button id=noop type=button>Wait for code</button>
  <button id=google type=button onclick="document.getElementById('login').hidden=true;document.getElementById('form').hidden=false">Login with Google</button>
  <div id=login>Sign-in verification required.</div><form id=form hidden onsubmit="event.preventDefault();document.getElementById('status').textContent='Processing application'">
  <label>City<input id=city required></label><button id=send onclick="localStorage.setItem('send-count',String(Number(localStorage.getItem('send-count')||0)+1))">Submit application</button><div id=status></div></form></main>`;

async function scenario(id: string, calls: Call[], options: { specialistFails?: boolean; postSend?: boolean; exhausted?: boolean; model?: 'minimax';navigationDuringAdvice?:boolean } = {}) {
  config.dryRun = true;
  process.env.APPLICATION_REVIEW_MODE = options.postSend ? '' : 'prepare';
  const context = await browser.newContext(), page = await context.newPage();
  const url = `https://${id}.fixture.invalid/application`;
  await context.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid')
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  await page.goto(url);
  if (options.postSend) await page.evaluate(() => {
    document.getElementById('form')!.hidden = false;
    (document.getElementById('city') as HTMLInputElement).value = 'Sydney';
  });
  let parents = 0, specialists = 0,providerRequests=0;
  const readiness = createReadinessFixtureReply();
  globalThis.fetch = async (_url, init) => {
    assert.ok(++providerRequests<80,'Fixture exceeded its bounded scripted decision count');
    if (String(_url).includes('mailbox.fixture.invalid')) return Response.json({ error: 'Fixture mailbox unavailable' }, { status: 401 });
    const body = JSON.parse(String(init?.body));
    const system = body.messages.filter((message:any)=>message.role==='system');
    assert.equal(system.length,1);
    assert.equal(system[0].content,buildApplicationSystemPrompt(process.env.COVER_LETTER_INSTRUCTIONS),'only the owner-approved system text reaches either provider');
    assert.ok(body.messages.some((message:any)=>message.role==='user'&&typeof message.content==='string'&&message.content.startsWith('APPLICATION MODE\n')),'mode remains explicit runtime context');
    if (options.model === 'minimax') assert.equal(body.model, MINIMAX_APPLICATION_MODEL);
    else assert.equal(body.model, 'celeris-1-magnus', 'applying and supervisory calls use Magnus');
    assert.ok(!isSpecialistFixtureRequest(body), 'recovery must never launch another agent');
    assert.ok(body.tools.every((tool: any) => !/specialist|consult_application/.test(tool.function.name)), 'specialist tools must not be offered');
    const review = readiness(body); if (review) return review;
    const actionSchema=body.tools.find((tool:any)=>tool.function.name==='browser_action')?.function.parameters;
    if(actionSchema?.properties.action?.enum)assert.equal(actionSchema.properties.action.enum.includes('script'),!!options.postSend,'preparation hides scripts; ordinary Auto apply retains its existing actions');
    // Only the invalid-domain, route-isolated fixture can simulate an actual
    // send. The entry guard has already verified its dry-run isolation.
    if (options.postSend) config.dryRun = false;
    const call = calls[parents++];
    assert.ok(call, `Unexpected parent decision in ${id}; specialist calls: ${specialists}`);
    return Response.json({ usage: { prompt_tokens: options.exhausted ? 3_000_000 : 100, completion_tokens: 10 }, choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: `${id}-${parents}`, type: 'function', function: { name: call.name, arguments: fixtureToolArguments(body,call.name,call.args) } }] } }] });
  };
  try {
    const execute = () => runAgentOnlyApplication({ simulation: 'isolated-form', page,
      job: { id, title: 'Developer', company: 'Fixture', location: 'Sydney', platform: 'workday', url },
      profile: { name: 'Fictional Candidate', email: 'fixture@example.invalid', suburb: 'Sydney', skills: [] } as never, log: () => {} });
    const result = options.model === 'minimax' ? await withApplicationModel({ ...process.env, APPLICATION_AI_MODEL: 'minimax', OPENROUTER_API_KEY: 'fixture-only' }, execute) : await execute();
    const trace = JSON.parse(readFileSync(join(directory, 'traces', `${id}.json`), 'utf8'));
    return { result, specialists, parents, trace, city: await page.locator('#city').inputValue(), sends: await page.evaluate(() => Number(localStorage.getItem('send-count') || 0)) };
  } finally { await context.close(); }
}

try {
  await test('the applying agent recovers failed verification directly without a specialist', async () => {
    const code: Call = { name: 'enter_emailed_code', args: { purpose: 'sign_in', ref: 'f0', sender_hint: 'Fixture' } };
    const run = await scenario('failed-verification', [code, code, ...complete]);
    assert.equal(run.specialists, 0); assert.equal(run.result.outcome.status, 'prepared');
    assert.equal(run.city, 'Sydney'); assert.equal(run.sends, 0);
    assert.ok(run.trace.steps.slice(0, 2).every((step: any) => step.disposition === 'failed'));
  });
  await test('unchanged controls do not invoke a second agent or veto subsequent recovery', async () => {
    const run = await scenario('unchanged-controls', [...Array.from({ length: 5 }, () => click('#noop')), ...complete]);
    assert.equal(run.specialists, 0); assert.equal(run.result.outcome.status, 'prepared'); assert.equal(run.sends, 0);
  });
  await test('MiniMax gets repeated-read guidance and completes without specialist advice', async () => {
    const read: Call = { name: 'read_candidate_evidence', args: { query: 'document-inventory' } };
    const run = await scenario('repeated-evidence', [read, read, read, read, ...complete], { model: 'minimax' });
    assert.equal(run.specialists, 0); assert.equal(run.result.outcome.status, 'prepared');
    assert.equal(run.city, 'Sydney'); assert.equal(run.sends, 0);
    assert.ok(run.trace.steps.some((step: any) => /Repeated evidence reads/.test(step.result)));
  });
  await test('an unrecoverable technical error preserves a retry checkpoint without a consultation', async () => {
    const run = await scenario('technical-error', [{ name: 'finish', args: { status: 'error', reason: 'The verification service is unavailable.', evidence: 'The sign-in form still requires a code.' } }]);
    assert.equal(run.specialists, 0); assert.equal(run.result.outcome.status, 'error');
    assert.equal(run.sends, 0); assert.equal(run.result.submitPressed, false);
  });
} finally { globalThis.fetch = originalFetch; await browser.close(); closeCelerisQueues(); rmSync(directory, { recursive: true, force: true }); }
