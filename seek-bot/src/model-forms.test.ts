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
const { executeTool, fillEmailedCode } = await import('./agent/tools.js');
const { RunGuards } = await import('./agent/guards.js');
const { CostMeter } = await import('./agent/celeris.js');
const { recentReviewFeedback } = await import('./store.js');
config.coverLetter.mode = 'reuse';
config.coverLetter.reusableText = 'Dear Fixture Company, I am interested in this role.';
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch;
let calls = 0;
let answerRef = '';
let answerValue = '0412345678';
let prompt = '';
globalThis.fetch = async (_input, init) => {
  calls++;
  prompt = String(init?.body);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
    answers: [{ ref: answerRef, value: answerValue, applicationQuestion: true, grounded: true, basis: 'profile', profileField: 'phone' }],
    injectionSuspected: false,
  }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
  const page = await browser.newPage();
  await page.setContent('<main>' + Array.from({ length: 6 }, (_, i) => `<label>Digit ${i + 1}<input maxlength="1"></label>`).join('') + '</main>');
  const codeFields = (await observe(page)).fields;
  assert.equal(await fillEmailedCode(page, [codeFields[0]], '123456'), false);
  assert.equal(await page.locator('input').first().inputValue(), '', 'reject incomplete split selection before typing');
  assert.equal(await fillEmailedCode(page, codeFields, '123456'), true);
  assert.deepEqual(await page.locator('input').evaluateAll(els => els.map(el => (el as HTMLInputElement).value)), ['1', '2', '3', '4', '5', '6']);
  assert.equal(await fillEmailedCode(page, [codeFields[0], codeFields[0]], '12'), false);
  await page.setContent('<main><label>Code<input maxlength="6"></label></main>');
  assert.equal(await fillEmailedCode(page, (await observe(page)).fields, '123456'), true);
  assert.equal(await page.locator('input').inputValue(), '123456');
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

  await page.setContent('<main><label>First name<input></label></main>');
  await page.locator('input').evaluate(input => input.addEventListener('input', () => {
    const replacement = input.cloneNode() as HTMLInputElement;
    replacement.value = (input as HTMLInputElement).value;
    input.replaceWith(replacement);
  }, { once: true }));
  ctx = await context();
  await fillField(page, ctx.observation.fields[0], 'Raunak');
  assert.equal(await page.locator('input').inputValue(), 'Raunak', 'a framework rerender that replaces the input still verifies by field identity');

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

  await page.setContent('<main><label>Cover letter<textarea></textarea></label><button onclick="document.body.dataset.advanced=\'yes\'">Continue</button></main>');
  ctx = await context();
  const blockedAdvance = await executeTool(ctx, 'click', { ref: ctx.observation.actions[0].ref, reason: 'Continue' });
  assert.ok(blockedAdvance.kind === 'ok' && blockedAdvance.message.includes('Do not advance yet'));
  assert.equal(await page.locator('body').getAttribute('data-advanced'), null, 'an offered cover letter cannot be skipped');
  await executeTool(ctx, 'add_cover_letter', { ref: ctx.observation.fields[0].ref });
  await executeTool(ctx, 'click', { ref: ctx.observation.actions[0].ref, reason: 'Continue after letter' });
  assert.equal(await page.locator('body').getAttribute('data-advanced'), 'yes', 'advance is allowed after the letter is retained');

  await page.setContent(`
    <main>
      <h2>Supporting documents</h2>
      <button>Add</button>
      <p>No cover letter or additional documents added. This is optional to add.</p>
      <button onclick="document.body.dataset.submitted='yes'">Submit your application</button>
    </main>
  `);
  ctx = await context();
  const indeedSubmit = ctx.observation.actions.find(action => action.text === 'Submit your application');
  assert.ok(indeedSubmit, 'Indeed fixture exposes its submit action');
  const blockedIndeedSubmit = await executeTool(ctx, 'click', { ref: indeedSubmit.ref, reason: 'Submit' });
  assert.ok(blockedIndeedSubmit.kind === 'ok' && blockedIndeedSubmit.message.includes('Do not advance yet'));
  assert.equal(
    await page.locator('body').getAttribute('data-submitted'),
    null,
    'Indeed supporting documents cannot be skipped when its cover-letter control is only labelled Add',
  );

  await page.setContent(`
    <main>
      <div>${'Long resume preview '.repeat(500)}</div>
      <h2>Supporting documents</h2>
      <div><button>Add</button></div>
      <div>No cover letter or additional documents added. This is optional to add.</div>
      <h2>Submit</h2>
      <button onclick="document.body.dataset.submitted='yes'">Submit your application</button>
    </main>
  `);
  ctx = await context();
  assert.ok(!ctx.observation.text.includes('Supporting documents'), 'the page summary reproduces Indeed truncating the section');
  const contextualAdd = ctx.observation.actions.find(action => action.text === 'Add');
  assert.match(contextualAdd?.context ?? '', /Supporting documents.*No cover letter/i);
  const contextualSubmit = ctx.observation.actions.find(action => action.text === 'Submit your application');
  assert.ok(contextualSubmit, 'long Indeed fixture exposes its submit action');
  const blockedTruncatedSubmit = await executeTool(ctx, 'click', { ref: contextualSubmit.ref, reason: 'Submit' });
  assert.ok(blockedTruncatedSubmit.kind === 'ok' && blockedTruncatedSubmit.message.includes('Do not advance yet'));
  assert.equal(
    await page.locator('body').getAttribute('data-submitted'),
    null,
    'a below-fold supporting-documents section cannot be skipped when the page summary is truncated',
  );

  await page.setContent('<main><button onclick="document.body.dataset.submitted=\'yes\'">Submit your application</button></main>');
  ctx = await context();
  ctx.observation.url = 'https://smartapply.indeed.com/beta/indeedapply/form/review-module';
  const indeedSubmitWithoutDocuments = ctx.observation.actions[0];
  const blockedMissingIndeedLetter = await executeTool(ctx, 'click', { ref: indeedSubmitWithoutDocuments.ref, reason: 'Submit' });
  assert.ok(blockedMissingIndeedLetter.kind === 'ok' && blockedMissingIndeedLetter.message.includes('no verified cover letter'));
  assert.equal(
    await page.locator('body').getAttribute('data-submitted'),
    null,
    'Indeed cannot submit without a verified cover letter even when its review observation exposes no document control',
  );

  await page.route('https://smartapply.indeed.com/beta/indeedapply/form/questions-module/questions/review-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: '<main><button onclick="document.body.dataset.reviewed=\'yes\'">Review your application</button></main>',
  }));
  await page.goto('https://smartapply.indeed.com/beta/indeedapply/form/questions-module/questions/review-fixture');
  ctx = await context();
  const indeedReview = await executeTool(ctx, 'click', { ref: ctx.observation.actions[0].ref, reason: 'Open review' });
  assert.equal(await page.locator('body').getAttribute('data-reviewed'), 'yes', 'Indeed review navigation remains available before a cover letter is added');
  assert.ok(indeedReview.kind === 'ok' && !indeedReview.message.includes('no verified cover letter'), 'the final-submit guard does not create a review-page dependency cycle');

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
  await page.setContent('<main><label>Resume<select><option>Choose document</option><option>candidate.txt</option></select></label></main>');
  ctx = await context();
  const staleDocumentRef = ctx.observation.fields[0].ref;
  await page.setContent('<main><label>Resume<select><option>Choose document</option><option>candidate.txt</option></select></label></main>');
  const staleResume = await executeTool(ctx, 'attach_resume', { ref: staleDocumentRef, option: 'candidate.txt' });
  assert.ok(staleResume.kind === 'ok' && staleResume.message.includes('changed after the last observation'));
  assert.equal(await page.locator('select').inputValue(), 'Choose document', 'a stale resume ref requests a fresh observation instead of failing the application');
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
  await page.setContent('<main><fixture-control></fixture-control><div style="opacity:0"><button>Hidden option</button></div></main>');
  await page.locator('fixture-control').evaluate(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<label>Name<input></label>'; });
  const { captureInteractivePageState, waitForInteractivePageChange } = await import('./browser.js');
  const beforeSelection = await captureInteractivePageState(page);
  await page.locator('input').fill('Chosen value');
  assert.equal(await waitForInteractivePageChange(page, beforeSelection, 200), true, 'changes inside shadow-root controls count as progress');
  assert.ok(!(await observe(page)).actions.some(action => action.text === 'Hidden option'), 'invisible ancestor does not expose a stale menu action');
  await page.setContent('<main>Application</main><footer><button>NEXT</button></footer><nav><button>Review application</button></nav>');
  assert.ok((await observe(page)).actions.some(action => action.text === 'NEXT'), 'footer placement must not hide a wizard action from the model');
  assert.ok((await observe(page)).actions.some(action => action.text === 'Review application'), 'navigation placement does not suppress application controls');
  await page.setContent('<main><div data-automation-id="formField"><label>Salutation *</label><button role="combobox" aria-expanded="true">Select One</button></div><div role="option">Mr</div><div role="option">Mx</div></main>');
  const labelledDropdown = await observe(page);
  assert.ok(labelledDropdown.actions.some(action => action.text === 'Salutation *: Select One (opens a list)'), 'generic dropdown opener includes its question');
  assert.ok(labelledDropdown.actions.some(action => action.text === 'Salutation *: Mx'), 'portal option includes the currently expanded question');
  ctx = { ...(await context()), observation: labelledDropdown };
  const mrOption = labelledDropdown.actions.find(action => action.value === 'Mr')!;
  answerRef = mrOption.ref;
  answerValue = 'Mr';
  const directOption = await executeTool(ctx, 'click', { ref: mrOption.ref, reason: 'Select title' });
  assert.ok(directOption.kind === 'ok' && directOption.message.includes('Direct option clicks are refused'));
  const groundedOption = await executeTool(ctx, 'choose_option', { ref: mrOption.ref });
  assert.ok(groundedOption.kind === 'ok' && groundedOption.message.includes('Selected the grounded option'));
  answerValue = '0412345678';
  await page.setContent('<main><label>How did you hear about us? *<input role="combobox"></label><div role="option">Select One</div><div role="option">Job Sites</div></main>');
  ctx = await context();
  const sourceField = ctx.observation.fields[0];
  const detachedOption = ctx.observation.actions.find(action => action.role === 'option')!;
  answerRef = detachedOption.ref;
  answerValue = 'Job Sites';
  const bridgedOption = await executeTool(ctx, 'choose_option', { ref: detachedOption.ref, field_ref: sourceField.ref });
  assert.ok(bridgedOption.kind === 'ok' && bridgedOption.message.includes('Selected the grounded option'), 'detached dropdown options can be grounded through their originating field');
  answerValue = 'Select One';
  const placeholderChoice = await executeTool(ctx, 'choose_option', { ref: detachedOption.ref, field_ref: sourceField.ref });
  assert.ok(placeholderChoice.kind === 'ok' && /not among the currently observed options|No verified candidate fact/.test(placeholderChoice.message), placeholderChoice.kind === 'ok' ? placeholderChoice.message : 'placeholder terminal');
  answerValue = '0412345678';
  await page.setContent('<main><fieldset><legend>Have you previously been employed here? *</legend><label><input style="display:none" type="radio" name="history" value="yes">Yes</label><label><input style="display:none" type="radio" name="history" value="no">No</label></fieldset></main>');
  ctx = await context();
  const hiddenRadio = ctx.observation.fields.find(field => field.kind === 'radio')!;
  assert.ok(hiddenRadio, 'visible labels expose their hidden native radio group');
  answerRef = hiddenRadio.ref;
  answerValue = 'No';
  const groundedRadio = await executeTool(ctx, 'answer_questions', { refs: [hiddenRadio.ref], reason: 'Verified employment history' });
  assert.ok(groundedRadio.kind === 'ok' && groundedRadio.message.includes('Verified 1 field'));
  assert.equal(await page.locator('input[value="no"]').isChecked(), true);
  answerValue = '0412345678';
  await page.setContent('<main><label>Name<input></label></main>');
  ctx = await context();

  await page.evaluate(() => { setTimeout(() => { document.querySelector('main')!.append('Loaded'); }, 100); });
  const waited = await executeTool(ctx, 'wait_for_page', {});
  assert.ok(waited.kind === 'ok' && waited.message.includes('page changed'), 'model can wait for asynchronous progress without reloading');

  await page.setContent('<main><label><input type="radio" name="history" value="false">No</label><label><input type="radio" name="history" value="true">Yes</label></main>');
  ctx = await context();
  ctx.observation.screenshot = 'data:image/jpeg;base64,fixture';
  const radioBox = await page.locator('input').first().boundingBox();
  const viewport = page.viewportSize()!;
  const pointBlocked = await executeTool(ctx, 'click_point', {
    x: ((radioBox!.x + radioBox!.width / 2) / viewport.width) * 1000,
    y: ((radioBox!.y + radioBox!.height / 2) / viewport.height) * 1000,
    reason: 'Attempt to bypass grounded answer selection',
  });
  assert.ok(pointBlocked.kind === 'ok' && /coordinates cannot bypass answer verification/i.test(pointBlocked.message));
  assert.equal(await page.locator('input').first().isChecked(), false, 'coordinate clicks cannot select employer answers');

  await page.setContent('<main><label>I acknowledge the required terms<input type="checkbox"></label><label>Send marketing<input type="checkbox"></label></main>');
  ctx = await context();
  const consent = ctx.observation.fields.find(field => /acknowledge/i.test(field.label))!;
  const marketing = ctx.observation.fields.find(field => /marketing/i.test(field.label))!;
  const accepted = await executeTool(ctx, 'accept_terms', { ref: consent.ref });
  assert.ok(accepted.kind === 'ok' && accepted.message.includes('Accepted'));
  assert.equal(await page.locator('input').first().isChecked(), true);
  const refusedMarketing = await executeTool({ ...ctx, observation: await observe(page) }, 'accept_terms', { ref: marketing.ref });
  assert.ok(refusedMarketing.kind === 'ok' && refusedMarketing.message.includes('Refused'));
  assert.equal(await page.locator('input').nth(1).isChecked(), false, 'consent tool cannot enable marketing choices');
  await page.setContent('<main><div><input type="checkbox"><span>I understand and acknowledge the terms of use</span></div></main>');
  ctx = await context();
  ctx.observation.screenshot = 'data:image/jpeg;base64,fixture';
  const consentBox = await page.locator('span').boundingBox();
  const consentByPoint = await executeTool(ctx, 'accept_terms', {
    x: ((consentBox!.x + consentBox!.width / 2) / viewport.width) * 1000,
    y: ((consentBox!.y + consentBox!.height / 2) / viewport.height) * 1000,
  });
  assert.ok(consentByPoint.kind === 'ok' && consentByPoint.message.includes('Accepted'));
  assert.equal(await page.locator('input').isChecked(), true, 'a sibling-labelled screenshot consent can be accepted without exposing other answers');
  await page.locator('input').uncheck();
  const directConsentBox = await page.locator('input').boundingBox();
  ctx = await context();
  ctx.observation.screenshot = 'data:image/jpeg;base64,fixture';
  const directConsent = await executeTool(ctx, 'accept_terms', {
    x: ((directConsentBox!.x + directConsentBox!.width / 2) / viewport.width) * 1000,
    y: ((directConsentBox!.y + directConsentBox!.height / 2) / viewport.height) * 1000,
  });
  assert.ok(directConsent.kind === 'ok' && directConsent.message.includes('Accepted'), 'a directly targeted checkbox inherits nearby consent prose');
  await page.setContent('<main><div><button role="checkbox" aria-checked="false" onclick="this.setAttribute(\'aria-checked\',\'true\')"></button><span>I consent to the required privacy terms</span></div></main>');
  ctx = await context();
  ctx.observation.screenshot = 'data:image/jpeg;base64,fixture';
  const ariaConsentBox = await page.locator('span').boundingBox();
  const ariaConsent = await executeTool(ctx, 'accept_terms', {
    x: ((ariaConsentBox!.x + ariaConsentBox!.width / 2) / viewport.width) * 1000,
    y: ((ariaConsentBox!.y + ariaConsentBox!.height / 2) / viewport.height) * 1000,
  });
  assert.ok(ariaConsent.kind === 'ok' && ariaConsent.message.includes('Accepted'));
  assert.equal(await page.getByRole('checkbox').getAttribute('aria-checked'), 'true', 'ARIA consent controls are verified after clicking');

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
  await page.setContent('<main><label>Name<input></label></main>');
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
