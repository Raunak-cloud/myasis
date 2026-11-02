import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { observe } from './observe.js';
import { extractEmployerQuestions, questionEvidenceIssue, quotedQuestions } from './question-evidence.js';
import type { ToolContext } from './context.js';

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  const context = async () => ({ page, observation: await observe(page) }) as ToolContext;
  await page.setContent('<label>Verification code<input autocomplete="one-time-code" required></label><label>Postcode<input value="2000" required></label><label>Security policy code<input value="SAFE-42" required></label>');
  const privateCtx = await context();
  const otp = privateCtx.observation.fields.find(field => field.label === 'Verification code')!;
  assert.ok((await extractEmployerQuestions(privateCtx, [{ field_ref: otp.ref }])).issue, 'private fields cannot become candidate tasks');
  assert.ok(await questionEvidenceIssue(privateCtx, [{ form_quote: 'Verification code', field_ref: otp.ref }]), 'ephemeral authentication codes cannot become saved candidate questions');
  for (const label of ['Postcode', 'Security policy code']) {
    const field = privateCtx.observation.fields.find(field => field.label === label)!;
    assert.equal(field.sensitive, false);
    assert.equal(await questionEvidenceIssue(privateCtx, [{ form_quote: label, field_ref: field.ref }]), null, 'ordinary business/code questions remain eligible');
  }
  await page.setContent('<fieldset><legend>Date of Birth *</legend><label>Month<input></label><label>Day<input></label><label>Year<input></label></fieldset>');
  let ctx = await context();
  const automaticDate = await extractEmployerQuestions(ctx, [{ field_ref: ctx.observation.fields[0].ref, form_quote: 'Invented question' }]);
  assert.match(automaticDate.questions?.[0].question ?? '', /Date of Birth/, 'composite dates use employer text, not agent prose');
  assert.deepEqual(automaticDate.questions?.[0].snapshot?.controls.map(c=>c.label),['Month','Day','Year'],'all components stay with the original full question');
  const allDateParts=await extractEmployerQuestions(ctx,ctx.observation.fields.map(f=>({field_ref:f.ref})));
  assert.equal(allDateParts.questions?.length,1,'multiple references to one date group produce one complete question');
  assert.equal(await questionEvidenceIssue(ctx, [{ question: 'Date of Birth', form_quote: 'Date of Birth *', field_ref: ctx.observation.fields[0].ref }]), null, 'a composite date can quote its real group heading');
  const fullDate = [{ field_ref: ctx.observation.fields[0].ref, form_quote: 'Date of Birth * Month Day Year', kind: 'text' }];
  assert.equal(await questionEvidenceIssue(ctx, fullDate), null);
  assert.match(quotedQuestions(fullDate)[0].question, /Date of Birth.*Month Day Year/, 'the complete employer group survives without requiring a literal human paraphrase');

  await page.setContent('<fieldset><legend>Current clearance *</legend><label><input type="radio" name="clearance">None</label><label><input type="radio" name="clearance">NV2</label></fieldset>');
  ctx = await context();
  const radio = ctx.observation.fields.find(field => field.kind === 'radio')!;
  const automaticRadio = await extractEmployerQuestions(ctx, [{ field_ref: radio.ref, options: ['Made up'] }]);
  assert.equal(automaticRadio.questions?.[0].question, 'Current clearance *');
  assert.deepEqual(automaticRadio.questions?.[0].snapshot?.controls[0].choices.map(o=>o.label), ['None', 'NV2'], 'choices come from the employer, not the agent');
  assert.equal(await questionEvidenceIssue(ctx, [{ question: 'Current clearance', form_quote: 'Current clearance *', field_ref: radio.ref }]), null, 'logical radio groups can ground their real question');
  assert.equal(await questionEvidenceIssue(ctx, [{ question: 'Current clearance', form_quote: 'Current clearance *', field_ref: `${radio.ref}:1` }]), null, 'an observed radio option can anchor its group');
  assert.equal(await page.locator('input:checked').count(), 0, 'grounding never chooses a radio answer');

  await page.setContent('<section><h2>Eligibility</h2><div><p>Do you have a current criminal record?</p><label><input type="checkbox" name="yes" value="Y">Yes</label><label><input type="checkbox" name="no" value="N">No</label></div></section>');
  ctx=await context();
  const criminal=await extractEmployerQuestions(ctx,ctx.observation.fields.map(f=>({field_ref:f.ref})));
  assert.equal(criminal.questions?.length,1);
  const crime=criminal.questions![0].snapshot!;
  assert.equal(crime.prompt,'Do you have a current criminal record?');
  assert.deepEqual(crime.context,['Eligibility']);
  assert.equal(crime.controls[0].kind,'checkbox-group');
  assert.deepEqual(crime.controls[0].choices.map(o=>[o.label,o.value]),[['Yes','Y'],['No','N']]);

  await page.setContent('<label>Available from<input type="date" min="2026-01-01" max="2027-12-31" required></label><label>Regions<select multiple required><optgroup label="East"><option value="s1">Sydney</option><option value="s2" disabled>Sydney</option></optgroup><optgroup label="West"><option value="p">Perth</option></optgroup></select></label>');
  ctx=await context();
  await page.locator('input[type=date]').fill('2026-11-03');
  const typed=await extractEmployerQuestions(ctx,ctx.observation.fields.map(f=>({field_ref:f.ref})));
  assert.equal(typed.questions?.length,2);
  const date=typed.questions![0].snapshot!,regions=typed.questions![1].snapshot!;
  assert.equal(date.controls[0].kind,'date');
  assert.deepEqual(date.controls[0].constraints,{min:'2026-01-01',max:'2027-12-31'});
  assert.equal(JSON.stringify(date).includes('2026-11-03'),false,'candidate values never become question metadata');
  assert.equal(regions.controls[0].multiple,true);
  assert.deepEqual(regions.controls[0].choices.map(o=>[o.label,o.value,o.group,o.disabled]),[['Sydney','s1','East',false],['Sydney','s2','East',true],['Perth','p','West',false]]);

  await page.setContent('<label>Country<select>'+Array.from({length:150},(_,i)=>`<option value="c${i}">Country ${i}</option>`).join('')+'</select></label>');
  ctx=await context();
  assert.equal((await extractEmployerQuestions(ctx,[{field_ref:ctx.observation.fields[0].ref}])).questions?.[0].snapshot?.controls[0].choices.length,150,'capture does not use the observation option truncation');

  await page.setContent('<span id="q">Preferred location</span><input role="combobox" aria-labelledby="q" aria-controls="list"><div id="list" role="listbox"><div role="option" aria-posinset="1" aria-setsize="2">Sydney</div><div role="option" aria-posinset="2" aria-setsize="2">Melbourne</div></div>');
  ctx=await context();
  const customRef=ctx.observation.fields[0]?.ref??ctx.observation.actions.find(a=>a.question?.includes('Preferred location'))!.ref;
  const custom=await extractEmployerQuestions(ctx,[{field_ref:customRef}]);
  assert.equal(custom.questions?.[0].snapshot?.completeness,'complete');
  await page.locator('[role="option"]').last().evaluate(e=>e.remove());
  assert.equal((await extractEmployerQuestions(ctx,[{field_ref:customRef}])).questions?.[0].snapshot?.completeness,'recapture','virtualized partial lists cannot become finite answer choices');

  await page.setContent('<span id="carrier-q">Office location</span><div role="combobox" tabindex="0" aria-labelledby="carrier-q">Choose office<select hidden><option value="s">Sydney</option><option value="m">Melbourne</option><option value="p">Perth</option></select></div>');
  ctx=await context();
  const carrierRef=ctx.observation.actions.find(a=>a.question?.includes('Office location'))!.ref;
  const carrier=await extractEmployerQuestions(ctx,[{field_ref:carrierRef}]);
  assert.equal(carrier.questions?.[0].snapshot?.completeness,'complete','an owned native catalog can establish all options without opening or writing the widget');
  assert.deepEqual(carrier.questions?.[0].snapshot?.controls[0].choices.map(o=>o.label),['Sydney','Melbourne','Perth']);

  await page.setContent('<fieldset><legend>Employment 1</legend><label>Start date<input></label></fieldset><fieldset><legend>Employment 2</legend><label>Start date<input></label></fieldset>');
  ctx = await context();
  const repeated = ctx.observation.fields.map((field, index) => ({ question: 'Start date', form_quote: `Employment ${index + 1} Start date`, field_ref: field.ref }));
  const automaticRepeated = await extractEmployerQuestions(ctx, ctx.observation.fields.map(field => ({ field_ref: field.ref })));
  assert.deepEqual(automaticRepeated.questions?.map(q => [q.question,q.snapshot?.controls[0].label]), [['Employment 1','Start date'], ['Employment 2','Start date']]);
  assert.equal(await questionEvidenceIssue(ctx, repeated), null);
  assert.equal(quotedQuestions(repeated).length, 2, 'actual section quotes retain separate contexts for repeated date labels');

  await page.setContent('<label>Position title<input></label><label>Position title<input></label>');
  ctx = await context();
  assert.ok((await extractEmployerQuestions(ctx, [{ field_ref: ctx.observation.fields[0].ref }])).issue, 'repeated labels without grounded context must not become ambiguous tasks');
  assert.ok((await extractEmployerQuestions(ctx, [{ field_ref: ctx.observation.fields[0].ref, form_quote: 'Position title' }])).issue, 'a supplied repeated bare label still needs distinct context');

  const consent = 'You will be required to complete a police check as part of our recruitment process. Do you consent to these checks if you are the successful candidate?';
  await page.setContent(`<section><p>${consent}</p><custom-checkbox id="consent"><div><input id="consent" type="checkbox" required><label for="consent">*</label></div></custom-checkbox></section>`);
  ctx = await context();
  const checkbox = ctx.observation.fields.find(field => field.kind === 'checkbox')!;
  await page.locator('input').evaluate(node => { node.style.opacity = '0'; });
  const capturedConsent = await extractEmployerQuestions(ctx, [{ field_ref: checkbox.ref, form_quote: consent, kind: 'select', options: ['Invented option'] }]);
  assert.equal(capturedConsent.questions?.[0].question, consent, 'grounded rich-text question survives a punctuation-only native label and duplicate custom-host IDs');
  assert.equal(capturedConsent.questions?.[0].snapshot?.controls[0].kind, 'checkbox', 'kind comes from the current employer control');
  assert.ok(!capturedConsent.questions?.[0].options?.includes('Invented option'), 'agent cannot invent employer choices');
  assert.equal(await page.locator('input').isChecked(), false, 'question capture never grants consent');
  assert.equal((await extractEmployerQuestions(ctx, [{ field_ref: checkbox.ref, form_quote: 'Invented employer question' }])).questions?.[0].snapshot?.prompt, consent, 'an invented quote cannot replace the independently captured original question');

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
  assert.ok((await extractEmployerQuestions(ctx, [{ field_ref: ctx.observation.fields[0].ref }])).issue, 'a stale control is a bounded technical failure');
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
  assert.ok((await extractEmployerQuestions(ctx, [{ field_ref: nested.ref }])).issue, 'hidden frames cannot supply candidate questions');
  assert.ok(await questionEvidenceIssue(ctx, [{ question: 'Work rights', form_quote: 'Work rights *', field_ref: nested.ref }]), 'a hidden frame cannot prove a current question');
  console.log('PASS: real labels, composite dates, shadow groups and frames grounded; invented, editable, stale and hidden question evidence rejected. No employer application.');
} finally { await browser.close(); }
