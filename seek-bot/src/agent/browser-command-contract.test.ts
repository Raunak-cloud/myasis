import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { toolInputIssue } from './tool-input.js';
import { specialistFixtureReply } from './specialist-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'browser-command-contract-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', APPLICATION_AI_MODEL: 'celeris',
  DRY_RUN: 'false', ALLOW_EXTERNAL_APPLY: 'true', AGENT_BUDGET_USD: '0.20',
  FORM_CORPUS_DIR: join(directory, 'corpus'), APPLICATION_REVIEW_MODE: '', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false' });
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes/CV.txt'), 'Fictional test candidate');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv-1', label: 'Fixture', fileName: 'CV.txt' }]));
writeFileSync(join(directory, 'answers.json'), '[]');
let turn = 0;
globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const specialist = specialistFixtureReply(body); if (specialist) return specialist;
  const latest = () => body.messages.filter((message: any) => message.role === 'tool').at(-1).content;
  let call;
  if (turn === 0) {
    const schema = body.tools.find((tool: any) => tool.function.name === 'browser_action').function.parameters;
    assert.match(toolInputIssue({ action: 'script' }, schema)!, /\$\.script is required/);
    const batchSchema = body.tools.find((tool: any) => tool.function.name === 'browser_batch').function.parameters;
    assert.match(toolInputIssue({ actions: [{ action: 'script' }] }, batchSchema)!, /\$\.actions\[0\]\.script is required/);
    const uploadSchema = body.tools.find((tool: any) => tool.function.name === 'browser_upload').function.parameters;
    assert.match(toolInputIssue({ selector: '#resume' }, uploadSchema)!, /\$\.file_ids is required/);
    assert.ok(toolInputIssue({ action: 'wait', timeout_ms: 1000 }, schema));
    assert.equal(toolInputIssue({ action: 'wait', selector: '#ready', timeout_ms: 30000 }, schema), null);
    assert.ok(toolInputIssue({ action: 'wait', selector: '#ready', timeout_ms: 30001 }, schema));
    call = { name: 'browser_batch', args: { actions: [
      { action: 'fill', selector: '#name', value: 'Must not run' },
      { action: 'set_input_files', selector: '#resume' },
    ] } };
  } else if (turn === 1) {
    assert.match(latest(), /Invalid tool input: \$\.actions\[1\]\.file_ids is required/);
    call = { name: 'browser_batch', args: { actions: [
      { action: 'fill', selector: '#name', value: 'Alex Fixture' },
      { action: 'set_input_files', selector: '#resume', file_ids: ['cv-1'] },
      { action: 'inspect', selector: 'input' },
    ] } };
  } else if (turn === 2) {
    const result = JSON.parse(latest());
    assert.equal(result.completed, 3);
    assert.equal(JSON.parse(result.results[1].message).current.files[0], 'CV.txt');
    call = { name: 'browser_batch', args: { actions: [
      { action: 'script', script_intent: 'inspect', script: 'async function () { return { name: document.querySelector("#name").value, files: document.querySelector("#resume").files.length, inputs: window.inputEvents }; }' },
      { action: 'inspect', selector: '#name' },
    ] } };
  } else if (turn === 3) {
    const batch = JSON.parse(latest());
    assert.equal(batch.completed, 2);
    assert.deepEqual(JSON.parse(batch.results[0].message), { name: 'Alex Fixture', files: 1, inputs: 1 });
    assert.equal(JSON.parse(batch.results[1].message).value, 'Alex Fixture');
    call = { name: 'finish', args: { status: 'skipped', reason: 'Controlled browser contract fixture is complete.', evidence: 'Fixture contract test' } };
  } else throw Error('Unexpected paid/model turn in offline fixture');
  return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
    id: `contract-${turn++}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
  }] } }], usage: { prompt_tokens: 30, completion_tokens: 10 } });
}) as typeof fetch;
const { runApplicationAgent } = await import('./loop.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH }
  : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid')
    ? route.fulfill({ contentType: 'text/html', body: '<main>Fixture contract test</main>' }) : route.abort());
  const page = await context.newPage(), url = 'https://contract.employer.invalid/apply';
  await page.goto(url);
  await page.setContent('<main>Fixture contract test<label>Name<input id=name oninput="window.inputEvents=(window.inputEvents||0)+1"></label><label>Resume<input id=resume type=file></label></main>');
  const result = await runApplicationAgent({ page, job: { id: 'contract-fixture', title: 'Fixture', company: 'Fictional employer', location: 'Sydney', url, applicationMode: 'external' },
    profile: { name: 'Alex Fixture', email: 'fixture@example.invalid', skills: [], willingToRelocate: false } as never, log: () => {} });
  assert.equal(result.outcome.status, 'skipped');
  assert.equal(turn, 4);
  assert.equal(await page.locator('#name').inputValue(), 'Alex Fixture');
  console.log('PASS: actual advertised schemas reject incomplete calls; invalid batch makes no edits; corrected native fill, upload and script execute. No paid requests.');
} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
