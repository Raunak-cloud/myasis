import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
import type { ToolContext } from './tools/context.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-saved-form-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.DRY_RUN = 'true';
process.env.ALLOW_EXTERNAL_APPLY = 'true';
const haiku = process.env.TEST_APPLICATION_MODEL === 'haiku';
if (haiku) { process.env.APPLICATION_AI_MODEL = 'haiku'; process.env.ANTHROPIC_API_KEY = 'fictional-only'; }
let mode = 'approve';
let calls = 0;
let lastForm: import('./saved-form.js').SavedForm;
let duringReview: (() => Promise<void>) | undefined;
globalThis.fetch = (async (_url, init) => {
  calls++;
  const request = JSON.parse(String(init?.body));
  const content = request.messages[0].content;
  const prompt = typeof content === 'string' ? content : content.map((block: { text?: string }) => block.text ?? '').join('\n');
  const match = prompt.match(/<untrusted role="current-saved-form">([\s\S]*)<\/untrusted>/);
  assert.ok(match, 'every advancement uses the saved-form reviewer');
  lastForm = JSON.parse(match[1]);
  assert.equal(request.model, haiku ? 'claude-haiku-5-5' : 'celeris-1-magnus');
  if (mode === 'unavailable') throw Error('Fixture outage');
  if (duringReview) { const change = duringReview; duringReview = undefined; await change(); }
  let problems: unknown[] = [];
  const field = lastForm.fields.find(f => f.label.startsWith('Suburb')) ?? lastForm.fields[0];
  if (['invalid', 'missing', 'needs_candidate', 'unsupported'].includes(mode)) problems = [{
    ref: field.ref, field: field.label, value: field.currentValue ?? '', kind: mode, problem: 'Fixture current-form problem.',
  }];
  if (mode === 'wrong-ref') problems = [{ ref: 'frame99:f999', field: 'Suburb *', value: 'Lidcombe', kind: 'invalid', problem: 'Invented field.' }];
  if (mode === 'wrong-value') problems = [{ ref: field.ref, field: field.label, value: 'Old stale value', kind: 'unsupported', problem: 'Not on form.' }];
  return Response.json(haiku ? { content: [{ type: 'text', text: JSON.stringify({ problems }) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
    : { choices: [{ message: { role: 'assistant', content: JSON.stringify({ problems }) } }] });
}) as typeof fetch;
const { readSavedForm } = await import('./saved-form.js');
const { observe } = await import('./observe.js');
const { gateAdvance } = await import('./tools/gate.js');
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');
const { config } = await import('../config.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  let body = '';
  await page.route('https://saved.fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body }));
  const open = async (markup: string): Promise<ToolContext> => {
    body = markup; mode = 'approve';
    await page.goto('https://saved.fixture.invalid/application');
    return { page, job: { id: 'saved-form-fixture', title: 'Developer', company: 'Fixture', location: 'Sydney', url: page.url() },
      profile: { name: 'Fixture', email: 'fixture@example.test', phone: '', suburb: 'Lidcombe', state: 'NSW', nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' },
      observation: await observe(page), captured: [], actions: [], resumeSettled: true, letterResolved: true,
      guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60000, maxTotalMs: 600000, meter: new CostMeter(1) }), log: () => {} };
  };
  const good = '<main><label>Suburb *<input id="city" required value="Lidcombe" role="combobox" aria-expanded="false" aria-invalid="false"></label><button type="button">Submit application</button></main>';
  let ctx = await open(good);
  // Exactly the old failure: accepted search text is unchanged by a recovery
  // click, but the search path left pending and failed records behind.
  ctx.guards.pendingFields.add('Suburb *');
  ctx.guards.recordFillFailure('Suburb *', 'Old failure');
  ctx.guards.recordUngrounded('Suburb *');
  ctx.rawAnswerProblems = new Map([['Suburb *', { field: 'Suburb *', value: 'Wrong old value', problem: 'Old rejection' }]]);
  const before = calls;
  let result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
  assert.equal(result.proceed, false);
  assert.equal(!result.proceed && result.result.kind === 'terminal' && result.result.outcome.status, 'rehearsed');
  assert.equal(calls - before, 1, 'one saved-form review replaces conflicting pre-submit audits');
  assert.equal(ctx.guards.pendingFields.size + ctx.guards.ungrounded.length + ctx.guards.unfillable.size + ctx.rawAnswerProblems.size, 0);
  assert.deepEqual(ctx.captured, [{ question: 'Suburb *', answer: 'Lidcombe' }]);
  assert.equal(ctx.submissionAttempted, undefined, 'dry-run still withholds the press');

  const originalPilot = config.formSpeed;
  for (const pilot of [false, true]) {
    config.formSpeed = pilot;
    ctx = await open(good);
    ctx.guards.pendingFields.add('Suburb *');
    const reviewCalls = calls;
    result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
    assert.ok(!result.proceed && result.result.kind === 'terminal' && result.result.outcome.status === 'rehearsed');
    assert.equal(calls - reviewCalls, 1, `saved-form verification runs with admin form-speed pilot=${pilot}`);
    assert.equal(ctx.guards.pendingFields.size, 0);
  }
  config.formSpeed = originalPilot;

  ctx = await open(good.replace('aria-invalid="false"', 'aria-invalid="true"'));
  mode = 'invalid';
  result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
  assert.ok(!result.proceed && result.result.kind === 'ok' && /CURRENT saved form is not ready/.test(result.result.message));
  assert.ok(lastForm!.fields[0].validationError, 'validation changes are read even when text is unchanged');
  ctx = await open(good.replace('value="Lidcombe"', 'value=""'));
  mode = 'missing';
  result = await gateAdvance(ctx, 'Next');
  assert.ok(!result.proceed && result.result.kind === 'ok');
  assert.equal(ctx.guards.ungrounded.length, 0, 'a repairable blank is not a question for the candidate');
  mode = 'needs_candidate';
  result = await gateAdvance(ctx, 'Next');
  assert.ok(!result.proceed && result.result.kind === 'terminal' && result.result.outcome.status === 'needs-human');

  if (haiku) {
    ctx = await open(good); mode = 'unsupported';
    result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
    assert.ok(!result.proceed && result.result.kind === 'ok' && /repair_feedback/.test(result.result.message));
    result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
    assert.ok(!result.proceed && result.result.kind === 'terminal' && result.result.outcome.status === 'skipped');
    assert.equal(ctx.guards.ungrounded.length, 0, 'a repeated draft error must never create a candidate question');
  }

  ctx = await open(good);
  duringReview = () => page.locator('#city').fill('Changed after review');
  result = await gateAdvance(ctx, 'Next');
  assert.ok(!result.proceed && result.result.kind === 'ok' && /changed during verification/.test(result.result.message));
  assert.equal(ctx.captured.length, 0, 'a stale approval is never recorded');
  for (const corrupt of ['wrong-ref', 'wrong-value', 'unavailable']) {
    ctx = await open(good); mode = corrupt;
    result = await gateAdvance(ctx, 'Next');
    assert.ok(!result.proceed && result.result.kind === 'ok');
    result = await gateAdvance(ctx, 'Next');
    assert.ok(!result.proceed && result.result.kind === 'terminal' && result.result.outcome.status === 'skipped');
  }
  ctx = await open('<main><label>City<input value="Main city"></label><div id="shadow"></div><iframe srcdoc="&lt;label&gt;City&lt;input value=&quot;Embedded city&quot;&gt;&lt;/label&gt;"></iframe><iframe hidden srcdoc="&lt;label&gt;Hidden unrelated form&lt;input required value=&quot;hidden-frame-value&quot;&gt;&lt;/label&gt;"></iframe><input type="password" value="secret-value"><input type="hidden" value="hidden-secret"><label>Verification code<input id="otp" value="private-code"></label></main>');
  await page.locator('#shadow').evaluate(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<label>City<input value="Shadow city"></label>'; });
  await page.frames()[1].waitForSelector('input');
  const form = await readSavedForm(page);
  assert.equal(form.fields.length, 3);
  assert.equal(new Set(form.fields.map(f => f.ref)).size, 3, 'equal labels in frames and shadow roots retain distinct identities');
  assert.ok(form.fields.some(f => f.frame === 1 && f.currentValue === 'Embedded city'));
  assert.ok(!JSON.stringify(form).includes('secret-value') && !JSON.stringify(form).includes('hidden-secret')
    && !JSON.stringify(form).includes('private-code') && !JSON.stringify(form).includes('hidden-frame-value'));
  console.log('PASS: current-form authority, stale checklist repair, one review, invalid unchanged values, required blanks, missing facts, changed-state expiry, corrupt/outage fail-closed, frames/shadow roots, private values and dry-run protection.');
} finally {
  await browser.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-saved-form-'));
  rmSync(directory, { recursive: true, force: true });
}
