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
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes/CV.txt'), 'Fictional resume');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fixture CV', fileName: 'CV.txt' }]));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const originalFetch = globalThis.fetch;
type Call = { name: string; args: Record<string, unknown> };
const click = (selector: string): Call => ({ name: 'browser_action', args: { action: 'click', selector, sends_application: false } });
const stop: Call = { name: 'finish', args: { status: 'skipped', reason: 'Email verification could not finish.', evidence: 'The code field is still blank.' } };
const complete: Call[] = [click('#google'), { name: 'browser_action', args: { action: 'fill', selector: '#city', value: 'Sydney' } },
  { name: 'prepare_application', args: { answers: [], resume_id: 'cv', submit_selector: '#send' } }];
const html = `<main><h1>Fixture application sign in</h1><label>One-time code<input id=otp autocomplete=one-time-code></label>
  <button id=noop type=button>Wait for code</button>
  <button id=google type=button onclick="document.getElementById('login').hidden=true;document.getElementById('form').hidden=false">Login with Google</button>
  <div id=login>Sign-in verification required.</div><form id=form hidden onsubmit="event.preventDefault();document.getElementById('status').textContent='Processing application'">
  <label>City<input id=city required></label><button id=send onclick="localStorage.setItem('send-count',String(Number(localStorage.getItem('send-count')||0)+1))">Submit application</button><div id=status></div></form></main>`;

async function scenario(id: string, calls: Call[], options: { specialistFails?: boolean; postSend?: boolean; exhausted?: boolean; model?: 'minimax' } = {}) {
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
  let recoveryOperation:Call|undefined,blockedRecovery=false;
  let invalidAttentionStop=false;
  const readiness = createReadinessFixtureReply();
  globalThis.fetch = async (_url, init) => {
    assert.ok(++providerRequests<80,'Fixture exceeded its bounded scripted decision count');
    if (String(_url).includes('mailbox.fixture.invalid')) return Response.json({ error: 'Fixture mailbox unavailable' }, { status: 401 });
    const body = JSON.parse(String(init?.body));
    if (options.model === 'minimax') assert.equal(body.model, MINIMAX_APPLICATION_MODEL);
    else assert.equal(body.model, 'celeris-1-magnus', 'applying and supervisory calls use Magnus');
    if (isSpecialistFixtureRequest(body)) {
      specialists++;
      if(!options.postSend)assert.match(body.messages[0].content,/Semi auto or approved reconstruction.*Browser scripts.*unavailable/,'specialist sees the actual approved-mode restrictions');
      assert.deepEqual(body.tools?.map((tool:any)=>tool.function.name),['test_application_helper','return_application_advice'],'specialist can test isolated helpers or return typed advice but has no live browser or submission tool');
      assert.equal(body.tool_choice, 'required', 'the specialist may choose its typed advice terminal without executing a helper or any live action');
      assert.match(body.messages[1].content, /Login with Google/);
      assert.match(body.messages[1].content, /parent-history/);
      assert.equal(await page.locator('#city').inputValue(), '', 'specialist cannot change browser state');
      if (options.specialistFails) return new Response('Fixture provider unavailable', { status: 401 });
      return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 30 }, choices: [{ message: { content: null,
        tool_calls: [{ id: `specialist-${specialists}`, type: 'function', function: { name: 'return_application_advice', arguments: fixtureToolArguments(body, 'return_application_advice', { advice: 'Repeated code waits do not establish progress. The current page offers another sign-in method.',
          evidence: [{ source: 'page', detail: 'Login with Google is visible.' }], unknowns: [],
          nextSteps: ['Inspect the observed Login with Google control, use the existing candidate session, then verify the actual employer form.'],recovery_goal:{kind:'field-value',target:'City',value:'Sydney'} }) } }],
      } }] });
    }
    const review = readiness(body); if (review) return review;
    const taskText=body.messages.map((message:any)=>typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.map((part:any)=>part.text??'').join('\n'):'').reverse().find((text:string)=>text.includes('SPECIALIST RECOVERY OBLIGATION\n'));
    const task=taskText?JSON.parse(taskText.match(/SPECIALIST RECOVERY OBLIGATION\n([^\n]+)/)![1]):undefined;
    const forced=body.tool_choice?.function?.name;
    const scripted=(name:string,args:Record<string,unknown>)=>Response.json({usage:{prompt_tokens:100,completion_tokens:10},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`recovery-${name}-${Date.now()}`,type:'function',function:{name,arguments:fixtureToolArguments(body,name,args)}}]}}]});
    if(forced==='respond_to_specialist') {
      // Once advice arrives, this scripted parent follows the different repair
      // instead of replaying any remaining pre-escalation no-op decisions.
      while(calls[parents]?.args.selector==='#noop')parents++;
      blockedRecovery=calls[parents]?.name==='finish';
      recoveryOperation=blockedRecovery?{name:'browser_action',args:{action:'inspect',selector:'#otp'}}:calls[parents++];
      assert.ok(recoveryOperation,'Fixture requires a concrete recovery operation');
      return scripted(forced,{advice_id:task.advice_id,decision:'adopt',reason:'Use the current supported login method and complete the fictional City field.',evidence_quote:'Fixture application sign in',operation_tool:recoveryOperation.name,...(recoveryOperation.name==='browser_action'?{operation_action:recoveryOperation.args.action}:{}),operation_purpose:'Complete the current supported fictional repair.',verification:task.verification});
    }
    if(forced==='check_specialist_recovery')return scripted(forced,{advice_id:task.advice_id,assessment:blockedRecovery?'blocked':await page.locator('#city').inputValue()==='Sydney'?'resolved':'no_progress',result_quote:task.result.slice(0,Math.min(task.result.length,200)),observation_quote:'Fixture application sign in',reason:'Verified the actual tool result; until City is filled the specialist goal remains unresolved.'});
    if(forced==='finish'&&task?.phase==='blocked'){
      assert.deepEqual(body.tools.find((tool:any)=>tool.function.name==='finish').function.parameters.properties.status.enum,['skipped'],'a broken recovery protocol cannot ask the candidate a technical question');
      if(!invalidAttentionStop){invalidAttentionStop=true;return scripted('finish',{status:'needs-human',reason:'No candidate fact is missing; the recovery protocol could not finish.',evidence:'The controlled recovery protocol is blocked, rather than a candidate fact being unavailable.',questions:[{field_ref:'f0',kind:'text'}]});}
    }
    // Only the invalid-domain, route-isolated fixture can simulate an actual
    // send. The entry guard has already verified its dry-run isolation.
    if (options.postSend) config.dryRun = false;
    const call = recoveryOperation??calls[parents++];recoveryOperation=undefined;
    assert.ok(call, `Unexpected parent decision in ${id}; specialist calls: ${specialists}`);
    if (call.name === 'browser_action' && call.args.selector === '#google') assert.equal(specialists, 1, 'automatic advice arrives before the next recovery action');
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
  await test('ordinary customer gets automatic advice after failed verification attempts without requesting the specialist', async () => {
    const code: Call = { name: 'enter_emailed_code', args: { purpose: 'sign_in', ref: 'f0', sender_hint: 'Fixture' } };
    const run = await scenario('failed-verification', [code, code, ...complete]);
    assert.equal(run.specialists, 1); assert.equal(run.result.outcome.status, 'prepared');
    assert.equal(run.city, 'Sydney'); assert.equal(run.sends, 0); assert.equal(run.result.submitPressed, false);
    assert.ok(run.trace.steps.slice(0, 2).every((step: any) => step.disposition === 'failed'));
    const consultations = run.trace.steps.filter((step: any) => step.tool === 'consult_application_specialist');
    assert.equal(consultations.length, 1);
    assert.equal(consultations[0].label, 'Automatic read-only specialist escalation', 'the parent never requested the consultation');
    assert.match(consultations[0].result, /READ-ONLY SPECIALIST ADVICE/);
  });
  await test('successful calls with no progress also escalate', async () => {
    const run = await scenario('unchanged-controls', [...Array.from({ length: 5 }, () => click('#noop')), ...complete]);
    assert.equal(run.specialists, 1); assert.equal(run.result.outcome.status, 'prepared'); assert.equal(run.sends, 0);
  });
  await test('MiniMax repeated evidence reads get one automatic consultation and then complete the form', async () => {
    const read: Call = { name: 'read_candidate_evidence', args: { query: 'document-inventory' } };
    const run = await scenario('repeated-evidence', [read, read, read, read, ...complete], { model: 'minimax' });
    assert.equal(run.specialists, 1); assert.equal(run.result.outcome.status, 'prepared');
    assert.equal(run.city, 'Sydney'); assert.equal(run.sends, 0);
    assert.ok(run.trace.steps.some((step: any) => step.tool === 'read_candidate_evidence' && step.disposition === 'reobserve' && /Repeated evidence reads/.test(step.result)));
  });
  await test('a technical stop receives specialist advice before the application is abandoned', async () => {
    const run = await scenario('before-stop', [stop, ...complete]);
    assert.equal(run.specialists, 1); assert.equal(run.result.outcome.status, 'prepared');
    assert.equal(run.trace.steps[0].disposition, 'reobserve'); assert.equal(run.sends, 0);
  });
  await test('specialist provider failure leaves a truthful stop available without repeatedly paying for the same state', async () => {
    const run = await scenario('unavailable-specialist', [stop, stop], { specialistFails: true });
    assert.equal(run.specialists, 1); assert.equal(run.result.outcome.status, 'rehearsed');
    assert.match(run.result.outcome.status === 'rehearsed' ? run.result.outcome.stoppedAt : '', /Agent judgement: skipped/);
    assert.equal(run.result.submitPressed, false); assert.equal(run.sends, 0);
  });
  await test('a possible send gets a bounded read-only investigation without a specialist or another send', async () => {
    const run = await scenario('uncertain-send', [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }, stop, stop], { postSend: true });
    assert.equal(run.specialists, 0); assert.equal(run.result.outcome.status, 'skipped');
    assert.equal(run.result.submitPressed, true); assert.equal(run.sends, 1);
  });
  await test('the action budget cannot be extended by an automatic stopping consultation', async () => {
    const run = await scenario('exhausted-budget', [stop], { exhausted: true });
    assert.equal(run.specialists, 0); assert.equal(run.parents, 1); assert.equal(run.sends, 0);
  });
  await test('manual advice is not duplicated by automatic escalation on the same evidence', async () => {
    const run = await scenario('manual-advice', [{ name: 'consult_application_specialist', args: { question: 'Assess the code blocker and current sign-in alternatives.', focus: 'form' } }, stop]);
    assert.equal(run.specialists, 1); assert.equal(run.parents, 2); assert.equal(run.sends, 0);
    assert.equal(run.result.outcome.status, 'rehearsed');
    assert.ok(run.trace.steps.some((step:any)=>step.label==='Recovery checkpoint response rejected'&&step.result.includes('status')),'a malformed technical Needs attention request is rejected before question capture');
  });
} finally {
  globalThis.fetch = originalFetch; await browser.close(); closeCelerisQueues(); rmSync(directory, { recursive: true, force: true });
}
