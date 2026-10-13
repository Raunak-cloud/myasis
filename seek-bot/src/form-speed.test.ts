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
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', FORM_SPEED_PILOT: 'true', DRY_RUN: 'false', CAPTCHA_SOLVER: 'off', RESUME_ALLOW_UPLOAD: 'true', RESUME_SELECT: '', EMPLOYER_BROWSER_PROVIDER: 'local' });
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
const { readPickerOptions } = await import('./dom.js');
const { checkSavedForm } = await import('./agent/tools/gate.js');
let calls = 0, answerValue = 'Verified fixture value', inject = false, grounded = true, basis = 'profile', applicationQuestion = true, omitOptional = false, lastFields: FormField[] = [];
globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const prompt = body.messages.map((m: { content: string }) => m.content).join('\n');
  const saved = prompt.match(/<untrusted role="current-saved-form">([\s\S]*)<\/untrusted>/);
  if (saved) {
    const form = JSON.parse(saved[1]) as import('./agent/saved-form.js').SavedForm;
    const problems = form.fields.flatMap(field => {
      const value = field.currentValue ?? '';
      const kind = field.required && !value.trim() ? 'missing' : field.validationError ? 'invalid'
        : value === 'Different value' ? 'unsupported' : null;
      return kind ? [{ ref: field.ref, field: field.label, value, kind, problem: 'Observed unfinished or rejected fixture answer.' }] : [];
    });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ problems }) } }] }), { status: 200 });
  }
  const text = prompt.split('<untrusted role="form-fields">')[1]?.split('</untrusted>')[0];
  if (!text) throw new Error('Unexpected model request in offline form fixture');
  calls++; lastFields = JSON.parse(text);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ answers: lastFields.filter(field => !omitOptional || field.required).map(field => ({ ref: field.ref, value: field.kind === 'select' ? field.options?.[0] : answerValue, grounded, basis, applicationQuestion, profileField: 'none' })), injectionSuspected: inject }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
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
  await check('unrelated selected chips cannot become another picker question or answer', async () => {
    await page.setContent('<main><label>Audit services<input role="combobox" aria-expanded="true" aria-controls="audit-options" required></label><div id="audit-options" role="listbox"><button role="option">Yes</button><button role="option">No</button></div><div role="listbox"><span role="option" aria-selected="true">Unrelated skill</span></div></main>');
    const ctx = await context();
    const field = ctx.observation.fields.find(f => f.label.includes('Audit services'))!;
    assert.equal(ctx.observation.actions.some(a => a.value === 'Unrelated skill'), false, 'another widget’s selected chips must not be offered as choices for the open picker');
    assert.deepEqual(await readPickerOptions(page, field.ref), ['Yes', 'No']);
  });
  await check('native picker handoffs preserve late choices and unknown popup ownership fails closed', async () => {
    await page.setContent('<main><label for="country">Country</label><select id="country">' + Array.from({ length: 230 }, (_, i) => `<option>Country ${i}</option>`).join('') + '</select><label>Other question<input role="combobox"></label><div role="listbox"><span role="option">Selected skill</span></div></main>');
    const fields = (await observe(page)).fields;
    assert.equal((await readPickerOptions(page, fields.find(f => f.label === 'Country')!.ref)).at(-1), 'Country 229');
    assert.deepEqual(await readPickerOptions(page, fields.find(f => f.label === 'Other question')!.ref), []);
  });
  await check('a deferred untouched optional field does not block but a required one does', async () => {
    await page.setContent('<main><label>Search selection<input role="combobox" required oninput="document.querySelector(\'#choices\').hidden=false"></label><div id="choices" role="listbox" hidden><span role="option">Fixture value</span></div><label>Required later<input required></label><label>Optional later<input></label></main>');
    const ctx = await context();
    await executeTool(ctx, 'answer_questions', { refs: ctx.observation.fields.map(f => f.ref), interaction: 'search' });
    assert(ctx.guards.pendingFields.has('Required later'));
    assert.equal(ctx.guards.pendingFields.has('Optional later'), false);
    assert.equal(await page.locator('input').last().inputValue(), '');
    const held = await checkSavedForm(ctx);
    assert.ok(held?.kind === 'ok');
    assert.match(held.message, /CURRENT saved form is not ready/, 'the actual saved form still blocks the deferred required blank');
  });
  await check('a model-omitted optional answer is not mistaken for an unconfirmed required answer', async () => {
    await page.setContent('<main><label>Required model fact<input required></label><label>Optional omitted fact<input></label></main>');
    const ctx = await context();
    omitOptional = true;
    try { await executeTool(ctx, 'answer_questions', { refs: ctx.observation.fields.map(f => f.ref) }); }
    finally { omitOptional = false; }
    assert.equal(await page.locator('input').last().inputValue(), '');
    assert.equal(ctx.guards.pendingFields.size, 0);
    assert.equal(await checkSavedForm(ctx), null, 'an omitted optional answer passes the actual saved-form review');
  });
  await check('a failed optional write still blocks submission of an unverified value', async () => {
    await page.setContent('<main><label>Optional rejected fact<input oninput="this.value=\'Different value\'"></label></main>');
    const ctx = await context();
    await executeTool(ctx, 'answer_questions', { refs: ctx.observation.fields.map(f => f.ref) });
    assert.equal(await page.locator('input').inputValue(), 'Different value');
    assert(ctx.guards.pendingFields.has('Optional rejected fact'));
    const held = await checkSavedForm(ctx);
    assert.ok(held?.kind === 'ok');
    assert.match(held.message, /not supported by the candidate/, 'the actual unsupported saved value still blocks advancement');
  });
  await check('a dropdown classified as a site control releases an old question blocker', async () => {
    await page.setContent('<main><label>Search catalogue<input role="combobox" aria-expanded="true" aria-controls="catalogue"></label><div id="catalogue" role="listbox"><button role="option">Fixture search</button></div></main>');
    const ctx = await context(); const field = ctx.observation.fields[0];
    ctx.guards.pendingFields.add(field.label);
    applicationQuestion = false;
    try { await executeTool(ctx, 'choose_option', { ref: ctx.observation.actions.find(a => a.role === 'option')!.ref }); }
    finally { applicationQuestion = true; }
    assert(ctx.guards.siteControls.has(field.label));
    assert.equal(ctx.guards.pendingFields.size, 0);
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
  await check('changed ARIA and slotted questions invalidate unchanged controls', async () => {
    await page.setContent('<main><span id="question">Original question</span><input aria-labelledby="question"><div id="host"><span slot="question">Original slotted question</span></div></main>');
    await page.evaluate(() => document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<label for="answer"><slot name="question"></slot></label><input id="answer">');
    const before = await currentFormStructure(page);
    await page.locator('#question').evaluate(el => el.textContent = 'Different question');
    const ariaChanged = await currentFormStructure(page); assert.notEqual(ariaChanged, before);
    await page.locator('[slot=question]').evaluate(el => el.textContent = 'Different slotted question');
    assert.notEqual(await currentFormStructure(page), ariaChanged);
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
    assert.match(JSON.stringify(result), /Resume file sent to the selected control/);
    assert.match(JSON.stringify(result), /fixture.txt/);
    await page.getByText('Upload rejected by server', { exact: true }).waitFor({ timeout: 3000 });
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
