import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { observe } from './observe.js';
import { questionEvidenceIssue, quotedQuestions } from './question-evidence.js';
import type { ToolContext } from './context.js';

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  const context = async () => ({ page, observation: await observe(page) }) as ToolContext;
  await page.setContent('<label>Verification code<input autocomplete="one-time-code" required></label><label>Postcode<input value="2000" required></label><label>Security policy code<input value="SAFE-42" required></label>');
  const privateCtx = await context();
  const otp = privateCtx.observation.fields.find(field => field.label === 'Verification code')!;
  assert.ok(await questionEvidenceIssue(privateCtx, [{ form_quote: 'Verification code', field_ref: otp.ref }]), 'ephemeral authentication codes cannot become saved candidate questions');
  for (const label of ['Postcode', 'Security policy code']) {
    const field = privateCtx.observation.fields.find(field => field.label === label)!;
    assert.equal(field.sensitive, false);
    assert.equal(await questionEvidenceIssue(privateCtx, [{ form_quote: label, field_ref: field.ref }]), null, 'ordinary business/code questions remain eligible');
  }
  await page.setContent('<fieldset><legend>Date of Birth *</legend><label>Month<input></label><label>Day<input></label><label>Year<input></label></fieldset>');
  let ctx = await context();
  assert.equal(await questionEvidenceIssue(ctx, [{ question: 'Date of Birth', form_quote: 'Date of Birth *', field_ref: ctx.observation.fields[0].ref }]), null, 'a composite date can quote its real group heading');
  const fullDate = [{ field_ref: ctx.observation.fields[0].ref, form_quote: 'Date of Birth * Month Day Year', kind: 'text' }];
  assert.equal(await questionEvidenceIssue(ctx, fullDate), null);
  assert.match(quotedQuestions(fullDate)[0].question, /Date of Birth.*Month Day Year/, 'the complete employer group survives without requiring a literal human paraphrase');

  await page.setContent('<fieldset><legend>Current clearance *</legend><label><input type="radio" name="clearance">None</label><label><input type="radio" name="clearance">NV2</label></fieldset>');
  ctx = await context();
  const radio = ctx.observation.fields.find(field => field.kind === 'radio')!;
  assert.equal(await questionEvidenceIssue(ctx, [{ question: 'Current clearance', form_quote: 'Current clearance *', field_ref: radio.ref }]), null, 'logical radio groups can ground their real question');
  assert.equal(await questionEvidenceIssue(ctx, [{ question: 'Current clearance', form_quote: 'Current clearance *', field_ref: `${radio.ref}:1` }]), null, 'an observed radio option can anchor its group');
  assert.equal(await page.locator('input:checked').count(), 0, 'grounding never chooses a radio answer');

  await page.setContent('<fieldset><legend>Employment 1</legend><label>Start date<input></label></fieldset><fieldset><legend>Employment 2</legend><label>Start date<input></label></fieldset>');
  ctx = await context();
  const repeated = ctx.observation.fields.map((field, index) => ({ question: 'Start date', form_quote: `Employment ${index + 1} Start date`, field_ref: field.ref }));
  assert.equal(await questionEvidenceIssue(ctx, repeated), null);
  assert.equal(quotedQuestions(repeated).length, 2, 'actual section quotes retain separate contexts for repeated date labels');

  await page.setContent('<div><span id="caption">Current clearance *</span><div role="combobox" tabindex="0" aria-labelledby="caption">Choose</div></div>');
  ctx = await context();
  const combobox = ctx.observation.actions.find(action => action.question?.includes('Current clearance'))!;
  assert.ok(combobox);
  assert.equal(await questionEvidenceIssue(ctx, [{ question: 'Current clearance', form_quote: 'Current clearance *', field_ref: combobox.ref }]), null, 'a semantic custom combobox without a native input remains supported');

  await page.setContent('<label>Notes<textarea></textarea></label><h1>Something went wrong.</h1>');
  const invented = 'Would you like me to retry later or apply manually?';
  await page.locator('textarea').fill(invented);
  ctx = await context();
  const bypass = [{ question: 'Notes', form_quote: 'Notes', field_ref: ctx.observation.fields[0].ref, prompt: invented }];
  assert.equal(await questionEvidenceIssue(ctx, bypass), null);
  assert.equal(quotedQuestions(bypass)[0].prompt, 'Notes', 'invented candidate-facing prose cannot bypass the grounded source');
  assert.ok(await questionEvidenceIssue(ctx, [...bypass, { ...bypass[0], form_quote: 'X'.repeat(501) }]), 'a malformed second question cannot be silently dropped from the group');
  assert.ok(await questionEvidenceIssue(ctx, [{ question: invented, form_quote: invented, field_ref: ctx.observation.fields[0].ref }]), 'candidate-authored text cannot prove an employer question');
  assert.ok(await questionEvidenceIssue(ctx, [{ question: invented, form_quote: 'Something went wrong.', field_ref: ctx.observation.fields[0].ref }]), 'an error quote cannot ground an invented operational question');
  assert.ok(await questionEvidenceIssue(ctx, [{ question: 'Notes', form_quote: 'Notes', field_ref: 'f999' }]), 'a guessed ref cannot ground a question');
  await page.locator('textarea').evaluate(node => node.remove());
  assert.ok(await questionEvidenceIssue(ctx, [{ question: 'Notes', form_quote: 'Notes', field_ref: ctx.observation.fields[0].ref }]), 'a removed control must be re-observed');
  await page.setContent('<label>Required personal detail *<input></label>');
  ctx = await context();
  await page.locator('input').evaluate(node => { (node as HTMLElement).style.display = 'none'; });
  assert.ok(await questionEvidenceIssue(ctx, [{ question: 'Required personal detail', form_quote: 'Required personal detail *', field_ref: ctx.observation.fields[0].ref }]), 'a visible label cannot revive its hidden stale text field');

  await page.setContent('<div id="shadow"></div>');
  await page.locator('#shadow').evaluate(node => { node.attachShadow({ mode: 'open' }).innerHTML = '<fieldset><legend>Current clearance *</legend><label>Clearance<select><option>Choose</option><option>None</option><option>NV2</option></select></label></fieldset>'; });
  ctx = await context();
  assert.equal(await questionEvidenceIssue(ctx, [{ question: 'Current clearance', form_quote: 'Current clearance *', field_ref: ctx.observation.fields[0].ref }]), null, 'open-shadow question groups remain supported');

  await page.setContent('<iframe srcdoc="<label>Work rights *<input></label>"></iframe>');
  await page.frameLocator('iframe').locator('input').waitFor();
  ctx = await context();
  const nested = ctx.observation.fields.find(field => field.ref.startsWith('frame'))!;
  assert.ok(nested);
  assert.equal(await questionEvidenceIssue(ctx, [{ question: 'Work rights', form_quote: 'Work rights *', field_ref: nested.ref }]), null, 'a visible employer frame can ground a real question');
  await page.locator('iframe').evaluate(node => { (node as HTMLElement).style.display = 'none'; });
  assert.ok(await questionEvidenceIssue(ctx, [{ question: 'Work rights', form_quote: 'Work rights *', field_ref: nested.ref }]), 'a hidden frame cannot prove a current question');
  console.log('PASS: real labels, composite dates, shadow groups and frames grounded; invented, editable, stale and hidden question evidence rejected. No employer application.');
} finally { await browser.close(); }
