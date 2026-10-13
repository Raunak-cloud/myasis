import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'patchright';
import type { CandidateProfile, FormField } from './types.js';
import type { ToolContext } from './agent/tools.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-form-speed-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', FORM_SPEED_PILOT: 'true', DRY_RUN: 'false', CAPTCHA_SOLVER: 'off' });
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'fixture.txt'), 'Approved synthetic resume');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'fixture', label: 'Fixture CV', fileName: 'fixture.txt', isDefault: true }]));
const { config } = await import('./config.js');
const { answerFields } = await import('./llm.js');
const { observe } = await import('./agent/observe.js');
const { executeTool } = await import('./agent/tools.js');
const { RunGuards } = await import('./agent/guards.js');
const { CostMeter } = await import('./agent/celeris.js');
const { boundedAnswerBatch, currentFormStructure, uploadObservedFile } = await import('./form-speed.js');
const { toolRun } = await import('./tool-run.js');
let calls = 0, answerValue = 'Verified fixture value', inject = false, grounded = true, basis = 'profile', lastFields: FormField[] = [];
globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const prompt = body.messages.map((m: { content: string }) => m.content).join('\n');
  const text = prompt.split('<untrusted role="form-fields">')[1]?.split('</untrusted>')[0];
  if (!text) throw new Error('Unexpected model request in offline form fixture');
  calls++; lastFields = JSON.parse(text);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ answers: lastFields.map(field => ({ ref: field.ref, value: field.kind === 'select' ? field.options?.[0] : answerValue, grounded, basis, applicationQuestion: true, profileField: 'none' })), injectionSuspected: inject }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
}) as typeof fetch;
const profile: CandidateProfile = { name: 'Fixture Candidate', email: 'fixture@example.com', phone: '0412345678', nationality: 'Australian', expectedSalary: '80000', noticePeriod: '2 weeks', willingToRelocate: false, skills: ['React'], experienceSummary: 'Builds software', excludedDomains: [], securityClearance: '' };
const job = { id: 'fixture-job', title: 'Developer', company: 'Fixture Employer', location: 'Sydney', url: 'https://employer.fixture.invalid/job/1' };
const field: FormField = { ref: 'f0', label: 'Profile fact', kind: 'text', required: true };
const timing: Record<string, unknown> = {};
const checks: string[] = [];
async function check(name: string, action: () => Promise<void>) { await action(); checks.push(name); }
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main>Offline fixture</main>' }));
  const context = async (): Promise<ToolContext> => ({ page, job, profile, observation: await observe(page), captured: [], actions: [], log: () => {}, guards: new RunGuards({ maxSteps: 60, maxStepsPerPage: 40, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) }) });
  await check('wide form uses fewer answer calls while preserving all values', async () => {
    for (const speed of [false, true]) {
      config.formSpeed = speed;
      await page.setContent('<main>' + Array.from({ length: 20 }, (_, i) => `<label>Verified fact ${i}<input name="fact${i}" required></label>`).join('') + '</main>');
      const ctx = await context(); const before = calls, start = performance.now();
      for (let turn = 0; turn < 10; turn++) {
        ctx.observation = await observe(page);
        const unanswered = ctx.observation.fields.filter(f => !f.currentValue);
        if (!unanswered.length) break;
        await executeTool(ctx, 'answer_questions', { refs: unanswered.map(f => f.ref) });
      }
      assert.deepEqual(await page.locator('input').evaluateAll(nodes => nodes.map(n => (n as HTMLInputElement).value)), Array(20).fill(answerValue));
      assert.equal(ctx.guards.pendingFields.size, 0);
      timing[speed ? 'pilot' : 'baseline'] = { answerCalls: calls - before, ms: performance.now() - start };
      assert.equal(calls - before, speed ? 1 : 4);
    }
  });
  await check('response budget reduces long-answer batches and still admits one large field', async () => {
    assert(boundedAnswerBatch(Array.from({ length: 20 }, (_, i) => ({ ...field, ref: `f${i}`, kind: 'textarea' as const })), 8192).length < 20);
    assert.equal(boundedAnswerBatch([{ ...field, options: Array(10_000).fill('Long choice') }], 512).length, 1);
  });
  await check('replacement controls with unchanged field count halt the old batch', async () => {
    await page.setContent('<main><label>First fact<input name="first" oninput="document.querySelector(\'#slot\').innerHTML=\'<label>Different fact<input name=changed></label>\'"></label><div id="slot"><label>Second fact<input name="second"></label></div></main>');
    const ctx = await context();
    const result = await executeTool(ctx, 'answer_questions', { refs: ctx.observation.fields.map(f => f.ref) });
    assert.equal(await page.locator('input[name=changed]').inputValue(), '');
    assert.equal(ctx.captured.length, 1); assert.match(JSON.stringify(result), /Not filled yet/);
  });
  await check('shadow-root changes are included in batch structure checks', async () => {
    await page.setContent('<main><div id="host"></div></main>');
    await page.evaluate(() => document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<input name="before">');
    const before = await currentFormStructure(page);
    await page.evaluate(() => document.querySelector('#host')!.shadowRoot!.innerHTML = '<input name="after">');
    assert.notEqual(await currentFormStructure(page), before);
  });
  await check('exact validated answer reuse survives ref changes and mixed new fields', async () => {
    const before = calls;
    await answerFields([field], job, profile);
    const next = await answerFields([{ ...field, ref: 'f99' }], job, profile);
    assert.equal(calls, before + 1); assert.equal(next.answers[0].ref, 'f99');
    await answerFields([{ ...field, ref: 'f99' }, { ...field, ref: 'f100', label: 'A new fact' }], job, profile);
    assert.deepEqual(lastFields.map(f => f.ref), ['f100']);
  });
  await check('owner directory, profile, job and form context changes invalidate reuse', async () => {
    const before = calls, old = config.dataDir;
    const b = resolve(directory, 'owner-b'); mkdirSync(b);
    config.dataDir = b; await answerFields([field], job, profile); config.dataDir = old;
    await answerFields([field], job, { ...profile, phone: '0499999999' });
    await answerFields([field], { ...job, company: 'Different employer' }, profile);
    await answerFields([field], job, profile, undefined, { formContext: 'Different page context' });
    assert.equal(calls, before + 4);
  });
  await check('changed choices and validation repairs never reuse a different question', async () => {
    const select: FormField = { ...field, kind: 'select', options: ['Yes', 'No'] };
    const before = calls;
    await answerFields([select], job, profile);
    await answerFields([{ ...select, options: ['No', 'Yes, full-time'] }], job, profile);
    await answerFields([{ ...field, validationError: 'Invalid value' }], job, profile);
    await answerFields([{ ...field, validationError: 'Invalid value' }], job, profile);
    assert.equal(calls, before + 4);
  });
  await check('changed document bytes invalidate reuse even when selected text is unchanged', async () => {
    const before = calls;
    writeFileSync(join(directory, 'resumes/fixture.txt'), 'Updated approved synthetic evidence');
    await answerFields([field], job, profile);
    assert.equal(calls, before + 1);
  });
  await check('dashboard overrides, unsupported answers, compositions and injections are not cached', async () => {
    const before = calls;
    for (let n = 0; n < 2; n++) await answerFields([field], job, profile, 'Explicit dashboard owner evidence');
    grounded = false;
    for (let n = 0; n < 2; n++) await answerFields([{ ...field, label: 'Unsupported fact' }], job, profile);
    grounded = true; basis = 'composed';
    for (let n = 0; n < 2; n++) await answerFields([{ ...field, label: 'Composed reply' }], job, profile);
    basis = 'profile'; inject = true;
    for (let n = 0; n < 2; n++) await answerFields([{ ...field, label: 'Injected question' }], job, profile);
    inject = false;
    assert.equal(calls, before + 8);
  });
  await check('upload replacement is read without waiting for the vanished input ref', async () => {
    await page.setContent('<main><label>Resume<input type="file" accept=".txt" onchange="const notice=document.createElement(\'p\');notice.textContent=\'Upload rejected by server\';this.replaceWith(notice)"></label></main>');
    const ctx = await context();
    const action = ctx.observation.actions.find(a => a.role === 'file')!;
    const start = performance.now();
    const result = await executeTool(ctx, 'attach_resume', { ref: action.ref });
    timing.uploadReplacementMs = performance.now() - start;
    assert(performance.now() - start < 2500);
    assert.match(JSON.stringify(result), /fixture.txt/);
    assert.match(await page.locator('body').innerText(), /Upload rejected/);
    assert.equal(result.kind, 'ok'); assert.match(JSON.stringify(result), /not application success/);
  });
  await check('pilot-disabled calls retain uncached grounding behaviour', async () => {
    config.formSpeed = false; const before = calls;
    await answerFields([field], job, profile); await answerFields([field], job, profile);
    assert.equal(calls, before + 2);
  });
  await check('an abandoned upload cannot write after locating its control', async () => {
    await page.setContent('<main><input type="file"></main>');
    const input = page.locator('input'), originalHandle = input.elementHandle.bind(input);
    const run = { generation: 1, retired: false };
    input.elementHandle = async options => { const handle = await originalHandle(options); run.retired = true; return handle; };
    await assert.rejects(toolRun.run(run, () => uploadObservedFile(input, resolve(directory, 'resumes/fixture.txt'))), /abandoned/);
    assert.equal(await page.locator('input').evaluate(el => (el as HTMLInputElement).files?.length), 0);
  });
  await check('finished background reviews release their deadline timer and worker process', async () => {
    const script = `
      globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({cause:'fixture',within_agent_control:false,lesson:''})}}]}),{status:200});
      const {reviewFailure,settleReviews}=await import(${JSON.stringify(new URL('./agent/lessons.js', import.meta.url).href)});
      reviewFailure({host:'fixture.example',company:'Fixture',title:'Developer',reason:'The form stopped changing',steps:[{tool:'click'},{tool:'click'},{tool:'click'}]});
      await settleReviews(60000); console.log('released');
    `;
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, env: { ...process.env, DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only' } });
    assert.match(child.stdout, /released/);
  });
  console.log(JSON.stringify({ ok: true, checks: checks.length, timing, scope: 'Synthetic browser + mocked model only; no employer contacted or application submitted' }));
} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
