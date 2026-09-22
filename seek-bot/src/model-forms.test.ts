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
  console.log('PASS: model-directed forms, genuine required metadata, coordinate grounding, argument validation, stale refs, and safe uploads');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
