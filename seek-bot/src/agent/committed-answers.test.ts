import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
const directory = mkdtempSync(join(tmpdir(), 'owtomate-committed-answers-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.FORM_SPEED_PILOT = 'true';
process.env.DRY_RUN = 'true';
let prompts: string[] = [];
let problems: Array<{ field: string; value: string; problem: string }> = [];
let unavailable = false;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  if (unavailable) throw new Error('fixture unavailable');
  const body = JSON.parse(String(init?.body ?? '{}'));
  prompts.push(JSON.stringify(body.messages));
  const current = String(body.messages[0].content).match(/<untrusted role="current-saved-form">([\s\S]*)<\/untrusted>/);
  const form = current ? JSON.parse(current[1]) : null;
  const reviewedProblems = form ? problems.map(problem => ({ ...problem,
    ref: form.fields.find((field: { label: string }) => field.label === problem.field)?.ref ?? 'page', kind: 'unsupported' })) : problems;
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ problems: reviewedProblems, answers: [{ ref: 'f0', grounded: false, value: '', candidatePrompt: 'What month did you start your degree?' }] }) } }], usage: {} }), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const { startRecording, readChanges, changedAnything } = await import('./page-changes.js');
const { checkGeneralToolAnswers, gateAdvance } = await import('./tools/gate.js');
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');
const { observe } = await import('./observe.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.route('https://careers.fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Education</h1><label for="start">Education Start Date Month</label><input id="start"><label for="birth">Date of Birth Month</label><input id="birth" value="July"><ul><li id="choice">January</li></ul><input type="password" id="secret" value="private"><input type="hidden" id="hidden" value="private"><button>Next</button></main>' }));
  await page.goto('https://careers.fixture.example/form');
  const ctx = { page, job: { id: 'fixture', title: 'Developer', company: 'Fixture', location: 'Sydney', url: page.url() }, profile: { name: 'Fixture Candidate', skills: [], excludedDomains: [] }, guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60000, maxTotalMs: 600000, meter: new CostMeter(1) }), observation: await observe(page), captured: [], actions: [], resumeSettled: true, log: () => {} } as never;
  let started = await startRecording(page);
  await page.locator('#choice').evaluate(node => node.classList.add('active'));
  let changes = await readChanges(page, started);
  assert.ok(changes.controls.length);
  assert.deepEqual(changes.values, [], 'highlighting a menu option does not commit an answer');
  await checkGeneralToolAnswers(ctx, changes.controls, changes.values);
  assert.equal(prompts.length, 0, 'menu movement does not ask the checker about unrelated saved birth facts');

  started = await startRecording(page);
  await page.locator('#start').evaluate(node => (node as HTMLInputElement).value = 'January');
  await page.locator('#secret').evaluate(node => (node as HTMLInputElement).value = 'changed-private');
  await page.locator('#hidden').evaluate(node => (node as HTMLInputElement).value = 'changed-private');
  changes = await readChanges(page, started);
  assert.equal(changes.values?.length, 1, 'silent property assignment is seen; private controls are not read');
  assert.equal(changedAnything(changes), true, 'a silent committed selection is real progress');
  problems = [{ field: 'Education Start Date Month', value: 'January', problem: 'The education month is not in the verified record.' }];
  const check = await checkGeneralToolAnswers(ctx, changes.controls, changes.values);
  assert.match(check, /NOT SUPPORTED/);
  assert.ok(prompts.at(-1)?.includes('Education Start Date Month'));
  assert.ok(!prompts.at(-1)?.includes('changed-private'));
  assert.ok(!prompts.at(-1)?.includes('Date of Birth Month'), 'the audit receives only changed fields, with their actual question');
  const held = await gateAdvance(ctx, 'Next');
  assert.equal(held.proceed, false, 'a model-rejected answer cannot be left behind on an earlier page');
  const heldAgain = await gateAdvance(ctx, 'Next');
  assert.equal(heldAgain.proceed, false);
  assert.equal((heldAgain as { result?: { outcome?: { status: string } } }).result?.outcome?.status, 'needs-human', 'repeated unresolved facts become a candidate question');

  started = await startRecording(page);
  await page.locator('#start').fill('September');
  changes = await readChanges(page, started);
  problems = [];
  await checkGeneralToolAnswers(ctx, changes.controls, changes.values);
  assert.equal((ctx as unknown as { rawAnswerProblems: Map<string, unknown> }).rawAnswerProblems.size, 0);
  assert.equal((ctx as unknown as { guards: InstanceType<typeof RunGuards> }).guards.ungrounded.length, 0, 'a verified replacement resolves the old rejection');

  problems = [{ field: 'Date of Birth Month', value: 'September', problem: 'Wrong unrelated month.' }];
  assert.match(await checkGeneralToolAnswers(ctx, changes.controls, changes.values), /ANSWER CHECK UNAVAILABLE/, 'an unrelated field returned by the model is rejected, not accepted as an audit');

  started = await startRecording(page);
  await page.locator('#start').fill('January');
  changes = await readChanges(page, started);
  problems = [{ field: 'Education Start Date Month', value: 'January', problem: 'Unknown education month.' }];
  await checkGeneralToolAnswers(ctx, changes.controls, changes.values);
  started = await startRecording(page);
  await page.locator('#start').fill('');
  changes = await readChanges(page, started);
  await checkGeneralToolAnswers(ctx, changes.controls, changes.values);
  assert.equal((ctx as unknown as { rawAnswerProblems: Map<string, unknown> }).rawAnswerProblems.size, 0, 'clearing an unsupported optional value removes its rejection');

  started = await startRecording(page);
  await page.locator('#start').fill('January');
  changes = await readChanges(page, started);
  unavailable = true;
  assert.match(await checkGeneralToolAnswers(ctx, changes.controls, changes.values), /ANSWER CHECK UNAVAILABLE/);
  await page.setContent('<div id="shadow"></div><iframe srcdoc="&lt;label&gt;Embedded city&lt;input id=city&gt;&lt;/label&gt;"></iframe>');
  await page.locator('#shadow').evaluate(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<input id="shadow-city">'; });
  await page.frames()[1].waitForSelector('#city');
  started = await startRecording(page);
  await page.locator('#shadow-city').evaluate(node => (node as HTMLInputElement).value = 'Shadow value');
  await page.frames()[1].locator('#city').evaluate(node => (node as HTMLInputElement).value = 'Embedded value');
  changes = await readChanges(page, started);
  assert.ok(changes.values?.some(value => value.value === 'Shadow value' && value.frame === 0));
  assert.ok(changes.values?.some(value => value.value === 'Embedded value' && value.frame === 1));
  console.log('PASS: silent value changes, precise question context, uncommitted highlights, private values, held navigation, candidate escalation, verified replacement and unavailable-check stop; offline fixtures only.');
} finally {
  await browser.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-committed-answers-'));
  rmSync(directory, { recursive: true, force: true });
}
