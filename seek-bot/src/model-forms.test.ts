import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { CandidateProfile } from './types.js';
import type { ToolContext } from './agent/tools.js';

// Isolated fixtures: no real account, application, candidate data or model API.
const directory = mkdtempSync(join(tmpdir(), 'owtomate-model-forms-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.GEMINI_API_KEY = 'fixture-only';
process.env.RESUME_ALLOW_UPLOAD = 'true';
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'candidate.txt'), 'Fixture resume');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([
  { id: 'fixture', label: 'Candidate CV', fileName: 'candidate.txt', isDefault: true },
]));
const { config } = await import('./config.js');
const { observe, renderObservation } = await import('./agent/observe.js');
const { fillField } = await import('./dom.js');
const { executeTool } = await import('./agent/tools.js');
const { RunGuards } = await import('./agent/guards.js');
const { CostMeter } = await import('./agent/celeris.js');
const { recentReviewFeedback } = await import('./store.js');
config.coverLetter.mode = 'reuse';
config.coverLetter.reusableText = 'Dear Fixture Company, I am interested in this role.';
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch;
let calls = 0;
let answerRef = '';
let prompt = '';
globalThis.fetch = async (_input, init) => {
  calls++;
  prompt = String(init?.body);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
    answers: [{ ref: answerRef, value: '0412345678', applicationQuestion: true, grounded: true, basis: 'profile', profileField: 'phone' }],
    injectionSuspected: false,
  }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
  const page = await browser.newPage();
  const profile: CandidateProfile = { name: 'Fixture Person', phone: '0412345678', email: 'fixture@example.com', nationality: 'Australian', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' };
  const context = async (): Promise<ToolContext> => ({
    page, profile, job: { id: 'fixture', title: 'Developer', company: 'Fixture Company', location: 'Sydney', url: 'https://example.com/job/fixture' },
    observation: await observe(page), captured: [], actions: [], log: () => {},
    guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) }),
  });
  await page.setContent('<main><label>Phone<input value="+61" aria-invalid="true" aria-errormessage="err"></label><p id="err">Only letters or numbers allowed</p></main>');
  await page.locator('input').evaluate(el => el.addEventListener('input', () => el.removeAttribute('aria-invalid')));
  let ctx = await context();
  answerRef = ctx.observation.fields[0].ref;
  assert.match(renderObservation(ctx.observation), /Only letters or numbers allowed/);
  await executeTool(ctx, 'answer_questions', { refs: [answerRef], reason: 'Repair rejected phone' });
  assert.equal(await page.locator('input').inputValue(), profile.phone);
  assert.equal(calls, 1, 'invalid nonempty defaults reach the grounded answer model');
  assert.equal(JSON.parse(prompt).model, 'celeris-1-magnus');
  assert.deepEqual(JSON.parse(prompt).chat_template_kwargs, { enable_thinking: true, reasoning_effort: 'low' });
  assert.match(prompt, /Only letters or numbers allowed/);

  await page.setContent('<main><label>Phone<input value="+61"></label></main>');
  ctx = await context();
  answerRef = ctx.observation.fields[0].ref;
  await executeTool(ctx, 'answer_questions', { refs: [answerRef], reason: 'Phone' });
  assert.equal(calls, 1, 'normal prefilled values are preserved');
  await executeTool(ctx, 'answer_questions', { refs: [answerRef], repair_refs: [answerRef], reason: 'This contains only the prefix, not the complete phone number' });
  assert.equal(await page.locator('input').inputValue(), profile.phone);
  assert.equal(calls, 2, 'model can request repair of an incomplete nonempty value');

  await page.setContent('<main><label>Phone<input role="combobox" aria-autocomplete="list"></label><label>Other phone<input></label></main>');
  ctx = await context();
  answerRef = ctx.observation.fields[0].ref;
  ctx.guards.recordFillFailure('Phone', 'No dropdown');
  ctx.guards.recordFillFailure('Phone', 'No dropdown');
  await executeTool(ctx, 'answer_questions', { refs: ctx.observation.fields.map(field => field.ref), interaction: 'type', reason: 'These are editable fields, not fixed dropdowns.' });
  assert.equal(await page.locator('input').first().inputValue(), profile.phone, 'free-text combobox needs no menu');
  assert.equal(await page.locator('input').nth(1).inputValue(), '', 'only one field changes before re-observation');
  assert.equal(ctx.guards.unfillable.has('Phone'), false, 'successful model retry clears previous failures');

  await page.setContent('<main><label>Phone<input role="combobox" oninput="document.querySelector(\'ul\').hidden=false"></label><ul role="listbox" hidden><li role="option" onclick="document.querySelector(\'input\').value=\'WRONG\'">Unrelated suggestion</li></ul></main>');
  ctx = await context();
  answerRef = ctx.observation.fields[0].ref;
  await executeTool(ctx, 'answer_questions', { refs: [answerRef], interaction: 'search', reason: 'Inspect suggestions first.' });
  assert.equal(await page.locator('input').inputValue(), profile.phone, 'no automatic suggestion choice');
  assert.ok((await observe(page)).actions.some(action => action.role === 'option'), 'model can see suggestions on the next turn');

  await page.setContent('<main><label>Still in role<input type="checkbox" onchange="document.querySelector(\'select\').style.visibility=this.checked?\'hidden\':\'visible\'"></label><label>End year<select><option>2026</option></select></label><label>Description<textarea></textarea></label></main>');
  ctx = await context();
  await fillField(page, ctx.observation.fields[0], 'true');
  const fresh = await observe(page);
  assert.equal(fresh.fields.length, 2);
  assert.equal(await page.locator('select').getAttribute('data-field-id'), null, 'hidden end-date ref is cleared');
  const marked = await page.locator('[data-field-id]').evaluateAll(elements => elements.map(el => el.getAttribute('data-field-id')));
  assert.equal(new Set(marked).size, marked.length, 'refs cannot collide after a layout change');
  await fillField(page, fresh.fields[1], 'Verified description', 'type');
  assert.equal(await page.locator('textarea').inputValue(), 'Verified description');

  await page.setContent('<main><label>Other notes<textarea>Keep me</textarea></label><label>Letter<textarea></textarea></label></main>');
  ctx = await context();
  await executeTool(ctx, 'add_cover_letter', { ref: ctx.observation.fields[1].ref });
  assert.equal(await page.locator('textarea').nth(0).inputValue(), 'Keep me');
  assert.equal(await page.locator('textarea').nth(1).inputValue(), config.coverLetter.reusableText);
  const invalid = await executeTool(ctx, 'add_cover_letter', { ref: 'f999' });
  assert.equal(invalid.kind, 'ok');
  assert.equal(await page.locator('textarea').nth(0).inputValue(), 'Keep me');

  await page.setContent('<main><label>Photo<input type="file" accept="image/*"></label><label>CV<input type="file" accept=".txt,.pdf"></label></main>');
  ctx = await context();
  const files = ctx.observation.actions.filter(action => action.role === 'file');
  await executeTool(ctx, 'attach_resume', { ref: files[0].ref });
  assert.equal(await page.locator('input').nth(0).evaluate(el => (el as HTMLInputElement).files?.length), 0);
  await executeTool(ctx, 'attach_resume', { ref: files[1].ref });
  assert.equal(await page.locator('input').nth(1).evaluate(el => (el as HTMLInputElement).files?.[0]?.name), 'candidate.txt');
  assert.equal(await page.locator('input').nth(0).evaluate(el => (el as HTMLInputElement).files?.length), 0);
  await page.setContent('<main><label>Resume<select><option>Choose document</option><option>Unrelated CV.pdf</option><option>candidate.txt</option></select></label></main>');
  ctx = await context();
  const documentRef = ctx.observation.fields[0].ref;
  await executeTool(ctx, 'attach_resume', { ref: documentRef, option: 'Unrelated CV.pdf' });
  assert.equal(await page.locator('select').inputValue(), 'Choose document');
  await executeTool(ctx, 'attach_resume', { ref: documentRef, option: 'candidate.txt' });
  assert.equal(await page.locator('select').inputValue(), 'candidate.txt');
  await page.route('https://au.seek.com/job/fixture/apply', route => route.fulfill({ contentType: 'text/html', body: '<main><label>Promotion<input type="checkbox"></label><label>Phone<input required></label><label>Country<select aria-required="true"><option>Australia</option></select></label></main>' }));
  await page.goto('https://au.seek.com/job/fixture/apply');
  ctx = await context();
  assert.equal(ctx.observation.fields[0].required, false, 'SEEK hostname cannot turn optional controls into required questions');
  assert.equal(ctx.observation.fields[1].required, true);
  assert.equal(ctx.observation.fields[2].required, true);
  ctx.observation.screenshot = 'fixture';
  const point = await page.locator('input[type=checkbox]').evaluate(el => { const r = el.getBoundingClientRect(); return { x: (r.x + r.width / 2) / innerWidth * 1000, y: (r.y + r.height / 2) / innerHeight * 1000 }; });
  await executeTool(ctx, 'click_point', { ...point, reason: 'Override a rejected choice' });
  assert.equal(await page.locator('input[type=checkbox]').isChecked(), false, 'coordinate clicks cannot bypass grounded field tools');
  const labelPoint = await page.locator('label').first().evaluate(el => { const r = el.getBoundingClientRect(); return { x: (r.x + 2) / innerWidth * 1000, y: (r.y + r.height / 2) / innerHeight * 1000 }; });
  await executeTool(ctx, 'click_point', { ...labelPoint, reason: 'Click label instead' });
  assert.equal(await page.locator('input[type=checkbox]').isChecked(), false, 'label clicks cannot bypass grounded field tools');
  await page.setContent('<main><label for="title">Preferred title</label><div><input id="title" value="Select"><button type="button" style="width:30px;height:30px"></button></div></main>');
  ctx = await context();
  assert.ok(ctx.observation.actions.some(action => action.text === 'Open Preferred title'), 'icon-only dropdown opener receives its associated field label');

  await page.setContent('<main><fixture-question><span slot="question">Preferred working arrangement</span></fixture-question></main>');
  await page.locator('fixture-question').evaluate(host => {
    host.attachShadow({ mode: 'open' }).innerHTML = '<label for="answer"><slot name="question"></slot>*</label><input id="answer">';
  });
  ctx = await context();
  assert.equal(ctx.observation.fields[0].label, 'Preferred working arrangement *', 'slotted question text is not reduced to the required marker');
  await page.setContent('<main><fixture-option>Full Time</fixture-option><input type="submit" value="Apply Now"></main>');
  await page.locator('fixture-option').evaluate(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<div role="option"><slot></slot></div>'; });
  ctx = await context();
  assert.ok(ctx.observation.actions.some(action => action.text === 'Full Time'), 'slotted dropdown option remains available to the model');
  assert.ok(ctx.observation.actions.some(action => action.text === 'Apply Now'), 'native submit input is a labelled action');
  await page.setContent('<main><label>Name<input></label></main>');
  ctx = await context();

  ctx.submissionAttempted = true;
  const reloadBlocked = await executeTool(ctx, 'reload_page', { reason: 'Temporary error' });
  assert.ok(reloadBlocked.kind === 'ok' && reloadBlocked.message.includes('Reload withheld'), 'cannot reload and replay an attempted submission');

  const beforeInvalid = calls;
  await executeTool(ctx, 'answer_questions', { refs: 'f1', reason: 'Malformed' });
  assert.equal(calls, beforeInvalid);
  writeFileSync(join(directory, 'review-history.jsonl'), [
    JSON.stringify({ ts: new Date().toISOString(), jobId: 'job1', title: 'Developer', company: 'Fixture', status: 'skipped', reason: 'Model found a skills mismatch' }),
    JSON.stringify({ ts: new Date(Date.now() - 8 * 86400_000).toISOString(), jobId: 'old', title: 'Developer', company: 'Fixture', status: 'skipped', reason: 'Expired memory' }),
    '{partial',
  ].join('\n'));
  const memory = recentReviewFeedback();
  assert.equal(memory.size, 1, 'stale and corrupt records do not become ranking context');
  assert.match(memory.get(JSON.stringify(['job1', 'Developer', 'Fixture']))!.reason, /skills mismatch/);
  const { rankJobsForReview, assessFit, reviewKey, fitCoverLetterToLimit, verifySubmissionEvidence } = await import('./llm.js');
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const text = JSON.stringify({ letter: 'I would welcome the opportunity to contribute.', supported: true, reason: 'No unsupported claims.' });
    return new Response(JSON.stringify(body.contents
      ? { candidates: [{ content: { parts: [{ text }] } }] }
      : { choices: [{ message: { role: 'assistant', content: text } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const shortLetter = await fitCoverLetterToLimit('A long letter. '.repeat(100), 100, ctx.job, profile);
  assert.ok(shortLetter.length <= 100 && shortLetter.endsWith('.'), 'model rewrites to the character limit without cutting off text');
  const evaluateOriginal = page.evaluate.bind(page);
  let raced = false;
  page.evaluate = (async (...args: Parameters<typeof page.evaluate>) => {
    if (!raced) { raced = true; throw new Error('Execution context was destroyed, most likely because of a navigation.'); }
    return evaluateOriginal(...args);
  }) as typeof page.evaluate;
  assert.ok((await observe(page)).fields.length > 0, 'read-only observation recovers from a navigation race');
  page.evaluate = evaluateOriginal;
  let retries = 0;
  const quote = 'Your application for Developer has been submitted.';
  globalThis.fetch = async () => {
    retries++;
    return new Response(JSON.stringify({ choices: [{ finish_reason: retries === 1 ? 'length' : 'stop', message: { role: 'assistant', content: JSON.stringify({ confirmed: true, quote }) } }] }), { status: 200 });
  };
  assert.equal(await verifySubmissionEvidence({ url: 'https://example.com/submitted', text: quote, actions: [], fields: [] }, ctx.job), true);
  assert.equal(retries, 2, 'malformed model generation is retried without replaying a browser action');
  assert.equal(await verifySubmissionEvidence({ url: 'https://example.com/form', text: 'Please complete this form.', actions: [], fields: [] }, ctx.job), false, 'invented confirmation quote cannot create a submission');
  const classifierCalls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'celeris-1', 'job classification stays on the fast model');
    assert.equal(body.chat_template_kwargs, undefined);
    const properties = body.response_format.json_schema.schema.properties;
    const kind = properties.jobs ? 'ranking' : properties.conflict ? 'instructions' : 'fit';
    classifierCalls.push(kind);
    const result = kind === 'ranking' ? { jobs: [{ reviewId: reviewKey(ctx.job), priority: 80, reason: 'Fixture match' }] }
      : kind === 'instructions' ? { conflict: '', because: 'No conflict', injectionSuspected: false }
      : { instructionConflict: '', decision: 'apply', matchScore: 80, reason: 'Fixture match', evidence: ['Fixture'], injectionSuspected: false };
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }] }), { status: 200 });
  };
  config.aiInstructions = 'No management roles';
  await rankJobsForReview([ctx.job], profile);
  assert.equal((await assessFit(ctx.job, profile)).shouldApply, true);
  assert.deepEqual(classifierCalls, ['ranking', 'instructions', 'fit']);
  console.log('PASS: model-directed forms, genuine required metadata, coordinate grounding, argument validation, stale refs, and safe uploads');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
