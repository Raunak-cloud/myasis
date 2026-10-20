import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { JobListing } from '../types.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-agent-only-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-only',
  APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true', ALLOW_EXTERNAL_APPLY: 'true', DRY_RUN: 'false' });
const haiku = process.env.TEST_APPLICATION_MODEL === 'haiku';
process.env.APPLICATION_AI_MODEL = haiku ? 'haiku' : 'celeris';
writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: 'Availability', answer: 'Weekends only' }]));
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Private candidate CV evidence: pharmacy placement.');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv-1', label: 'Pharmacy CV', fileName: 'CV.txt', isDefault: true }]));
writeFileSync(join(directory, 'applied.json'), JSON.stringify([{ id: 'old-job', title: 'Prior role', platform: 'seek', appliedAt: new Date().toISOString() }]));

type Call = { name: string; args: Record<string, unknown> };
type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; output_config?: { effort?: string }; chat_template_kwargs?: { reasoning_effort?: string } };
let script: Array<(body: Body) => Call[]> = [];
const turns: Body[] = [];
const observation = (body: Body) => JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content);
const reply = (calls: Call[]) => haiku
  ? Response.json({ content: calls.map((call, index) => ({ type: 'tool_use', id: `turn-${turns.length}-${index}`, name: call.name, input: call.args })), stop_reason: 'tool_use', usage: { input_tokens: 30, output_tokens: 10 } })
  : Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({ id: `turn-${turns.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }], usage: { prompt_tokens: 30, completion_tokens: 10 } });
globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as Body;
  assert.ok(body.tools?.length, 'no independent checker, answerer, receipt verifier or script reviewer may be called');
  turns.push(body);
  const next = script.shift();
  assert.ok(next, 'the parent makes only the scripted number of requests');
  return reply(next(body));
}) as typeof fetch;
const { runApplicationAgent } = await import('./loop.js');
const { withApplicationModel } = await import('../application-model.js');
const { config } = await import('../config.js');
const { withApplicationAllowance } = await import('../application-allowance.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const context = await browser.newContext();
  const form = `<main><h1>Pharmacy Assistant</h1><form onsubmit="event.preventDefault();window.presses=(window.presses||0)+1;if(!document.querySelector('select').value){document.querySelector('#validation').textContent='Please choose a referral source';return}document.querySelector('main').innerHTML='<h1>Application received</h1><p>Receipt ABC123</p>'">
    <label>Name<input id=name></label><label>Email<input id=email></label>
    <label>Cover letter<textarea id=letter></textarea></label><label>Referral source<select><option value=''>Please select</option><option value=website>Company website</option></select></label>
    <input type=file id=cv><p class=generic-validation id=validation></p><button id=submit>Submit</button></form></main>`;
  await context.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid')
    ? route.fulfill({ contentType: 'text/html', body: form }) : route.abort());
  const page = await context.newPage();
  const url = 'https://careers.agent.invalid/apply';
  await page.goto(url);
  const job = { id: 'agent-only-retry', title: 'Pharmacy Assistant', company: 'Fixture Pharmacy', location: 'Sydney', url, applicationMode: 'external' } as JobListing;
  const profile = { name: 'Rinu Fixture', email: 'fixture@example.invalid', phone: '0400000000', skills: ['Customer service'], experienceSummary: 'Pharmacy placement', willingToRelocate: false } as never;
  const letter = 'Dear team,\n\nI would like to apply for the pharmacy assistant role.\n\nKind regards,\nRinu';
  script = [body => {
    const all = JSON.stringify(body);
    assert.match(all, /Rinu Fixture/); assert.match(all, /Weekends only/); assert.match(all, /pharmacy placement/); assert.match(all, /old-job/);
    return [
      { name: 'browser_action', args: { action: 'fill', selector: '#name', value: 'Rinu Fixture' } },
      { name: 'browser_action', args: { action: 'fill', selector: '#email', value: 'fixture@example.invalid' } },
      { name: 'browser_action', args: { action: 'fill', selector: '#letter', value: letter } },
      { name: 'upload_document', args: { selector: '#cv', document_id: 'cv-1' } },
      { name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } },
    ];
  }, body => {
    assert.match(observation(body), /Please choose a referral source/);
    return [{ name: 'reason_through_problem', args: { problem: 'The first submission was rejected. Correct the actual referral source and retry.' } }];
  }, () => [
    { name: 'browser_action', args: { action: 'select', selector: 'select', value: 'Company website' } },
    { name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } },
  ], body => {
    assert.match(observation(body), /Application received/); assert.match(observation(body), /ABC123/);
    return [{ name: 'finish', args: { status: 'applied', reason: 'Received after correcting referral source', evidence: 'Application received, Receipt ABC123', cover_letter: letter, resume_id: 'cv-1' } }];
  }];
  let quotaChecks = 0;
  const run = await withApplicationAllowance(async external => { assert.equal(external, true); quotaChecks++; return true; },
    () => runApplicationAgent({ page, job, profile, log: () => {} }));
  assert.equal(run.outcome.status, 'applied');
  assert.equal(await page.evaluate('window.presses', undefined, undefined, false), 2);
  assert.equal(run.coverLetter, letter); assert.equal(run.resumeUsed, 'cv-1'); assert.equal(run.submitPressed, true);
  assert.equal(script.length, 0); assert.equal(turns.length, 4); assert.equal(quotaChecks, 7);
  const effort = (body: Body) => haiku
    ? (body.messages.filter(message => (message as unknown as { output_config?: { effort: string } }).output_config).at(-1) as unknown as { output_config?: { effort: string } })?.output_config?.effort ?? body.output_config?.effort
    : body.chat_template_kwargs?.reasoning_effort;
  assert.equal(effort(turns[0]), 'medium'); assert.equal(effort(turns[2]), haiku ? 'high' : 'xhigh');
  assert.match(readFileSync(join(directory, 'traces', 'agent-only-retry.json'), 'utf8'), /ABC123/);
  assert.equal(JSON.parse(readFileSync(join(directory, 'applied.json'), 'utf8')).length, 1, 'driver does not mutate history or reserve duplicate claims');

  await page.goto(url);
  script = [() => [{ name: 'browser_action', args: { action: 'script', script: '() => { document.querySelector("#name").value = "Scripted"; return document.querySelector("#name").value; }' } }],
    body => { assert.match(observation(body), /Scripted/); return [{ name: 'finish', args: { status: 'skipped', reason: 'Script exercised', evidence: 'Saved name Scripted' } }]; }];
  assert.equal((await runApplicationAgent({ page, job: { ...job, id: 'agent-script' } as never, profile, log: () => {} })).outcome.status, 'skipped');
  assert.equal(await page.inputValue('#name'), 'Scripted');

  await page.goto(url);
  script = [() => [
    { name: 'browser_action', args: { action: 'fill', selector: '#name' } },
    { name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } },
  ], body => {
    assert.match(JSON.stringify(body.messages), /Not run: the prior action failed/);
    assert.equal(effort(body), haiku ? 'high' : 'xhigh');
    return [{ name: 'finish', args: { status: 'needs-human', reason: 'A consequential candidate fact is unknown', evidence: 'No candidate evidence supplied for this fact' } }];
  }];
  const failedInput = await runApplicationAgent({ page, job: { ...job, id: 'agent-invalid-input' }, profile, log: () => {} });
  assert.equal(failedInput.outcome.status, 'needs-human');
  assert.equal(await page.evaluate('window.presses ?? 0', undefined, undefined, false), 0, 'a failed action retires the rest of that model plan');

  await page.goto(url);
  script = [() => [{ name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } }]];
  const denied = await withApplicationAllowance(async () => false, () => runApplicationAgent({ page, job: { ...job, id: 'agent-no-quota' }, profile, log: () => {} }));
  assert.equal(denied.outcome.status, 'skipped');
  assert.equal(await page.evaluate('window.presses ?? 0', undefined, undefined, false), 0, 'account quota still prevents transmission');

  config.dryRun = true;
  await page.goto(url);
  script = [() => [{ name: 'browser_action', args: { action: 'script', script: '() => { document.querySelector("#submit").click(); }', sends_application: true } }]];
  const dryRun = await runApplicationAgent({ page, job: { ...job, id: 'agent-dry' } as never, profile, log: () => {} });
  assert.equal(dryRun.outcome.status, 'rehearsed'); assert.equal(await page.evaluate('window.presses ?? 0', undefined, undefined, false), 0);
  script = [() => [{ name: 'finish', args: { status: 'applied', reason: 'Pretend', evidence: 'No actual receipt' } }]];
  assert.equal((await runApplicationAgent({ page, job: { ...job, id: 'agent-dry-finish' } as never, profile, log: () => {} })).outcome.status, 'rehearsed');
  const before = turns.length;
  await assert.rejects(withApplicationModel({ ...process.env, APPLICATION_AGENT_MODE_AUTHORIZED: 'false' }, async () => {
    const { runAgentOnlyApplication } = await import('./agent-only.js');
    return runAgentOnlyApplication({ page, job, profile });
  }), /trusted admin/);
  assert.equal(turns.length, before);
  config.dryRun = false;
  const maxMs = config.celeris.maxTotalMs;
  config.celeris.maxTotalMs = 1500;
  await page.goto(url);
  script = [() => [{ name: 'browser_action', args: { action: 'script', script: 'async () => new Promise(() => {})' } }]];
  const started = Date.now();
  const timed = await runApplicationAgent({ page, job: { ...job, id: 'agent-script-timeout' }, profile, log: () => {} });
  assert.equal(timed.outcome.status, 'skipped');
  assert.equal(page.isClosed(), true, 'outstanding script cannot continue into the next application');
  assert.ok(Date.now() - started < 8000, 'resource deadline retires an indefinitely pending browser script');
  config.celeris.maxTotalMs = maxMs;
  console.log(`Agent-only ${haiku ? 'Haiku' : 'Celeris'}: retry/receipt, full evidence, direct scripts, medium/high effort, quota, dry-run and authorization fixtures passed.`);
} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
