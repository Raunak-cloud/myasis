import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
let duplicateProblems = false;
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
  if (mode === 'claim-evidence') {
    const evidence = prompt.match(/<candidate-documents>([\s\S]*?)<\/candidate-documents>/)?.[1] ?? '';
    assert.match(evidence, /Nova Heart Centre.*Cardiology observership.*2024/, 'retrieve the current form claim even when vacancy-focused excerpts would omit it');
  }
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
  if (duplicateProblems && problems.length) problems = [...problems, ...problems];
  return Response.json(haiku ? { content: [{ type: 'text', text: JSON.stringify({ problems }) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
    : { choices: [{ message: { role: 'assistant', content: JSON.stringify({ problems }) } }] });
}) as typeof fetch;
const { readSavedForm } = await import('./saved-form.js');
const { observe } = await import('./observe.js');
const { gateAdvance } = await import('./tools/gate.js');
const { RunGuards, detectConfirmation } = await import('./guards.js');
const { ApplicationReservations, withApplicationAttempt } = await import('../application-reservations.js');
const { ApplicationSlots } = await import('../application-workers.js');
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
      observation: await observe(page), captured: [], actions: [], resumeSettled: true, declaredSubmit: false,
      guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60000, maxTotalMs: 600000, meter: new CostMeter(1) }), log: () => {} };
  };
  const good = '<main><label>Suburb *<input id="city" required value="Lidcombe" role="combobox" aria-expanded="false" aria-invalid="false"></label><button type="button">Submit application</button></main>';
  // A large candidate document: job-keyword passages used to crowd the
  // career entry out of the reviewer's evidence. No extra model call or
  // larger context budget is needed to retrieve the actual claim.
  writeFileSync(join(directory, 'knowledge.json'), JSON.stringify([{ id: 'history', kind: 'note', enabled: true,
    label: 'Candidate history', text: ('Developer software engineering project delivery. ' + 'Other duties. '.repeat(45) + '\n').repeat(60)
      + '\nNova Heart Centre — Cardiology observership — 2024.\n' }]));
  let evidenceCtx = await open('<main><p>Career history: Nova Heart Centre — Cardiology observership — 2024.</p><button>Continue</button></main>');
  mode = 'claim-evidence';
  assert.equal((await gateAdvance(evidenceCtx, 'Continue')).proceed, true);
  let ctx = await open(good);
  // Exactly the old failure: accepted search text is unchanged by a recovery
  // click, but the search path left pending and failed records behind.
  ctx.guards.pendingFields.add('Suburb *');
  ctx.guards.recordFillFailure('Suburb *', 'Old failure');
  ctx.guards.recordUngrounded('Suburb *');
  const before = calls;
  let result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
  assert.equal(result.proceed, false);
  assert.equal(!result.proceed && result.result.kind === 'terminal' && result.result.outcome.status, 'rehearsed');
  assert.equal(calls - before, 1, 'one saved-form review replaces conflicting pre-submit audits');
  assert.equal(ctx.guards.pendingFields.size + ctx.guards.ungrounded.length + ctx.guards.unfillable.size, 0);
  assert.deepEqual(ctx.captured, [{ question: 'Suburb *', answer: 'Lidcombe' }]);
  assert.equal(ctx.submissionAttempted, undefined, 'dry-run still withholds the press');

  // The Indeed failure: a read-only letter from an earlier attempt is on
  // review, while this attempt has no ctx.coverLetter bookkeeping.
  const review = '<main><h1>Review your application</h1><section><h2>Supporting documents</h2><p>Cover letter</p><p>Existing grounded letter for this employer.</p><button>Edit</button></section><button>Submit application</button></main>';
  ctx = await open(review);
  const letterCalls = calls;
  result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
  assert.ok(!result.proceed && result.result.kind === 'terminal' && result.result.outcome.status === 'rehearsed');
  assert.equal(calls - letterCalls, 1, 'an existing review letter reaches the single saved-form check without a document veto');
  assert.match(await page.locator('body').innerText(), /Existing grounded letter/);
  ctx = await open('<main><label>Cover letter<textarea></textarea></label><button>Submit application</button></main>');
  result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
  assert.ok(!result.proceed && result.result.kind === 'terminal' && result.result.outcome.status === 'rehearsed', 'an optional blank letter requires no special declaration');
  ctx = await open('<main><label>Cover letter<textarea required></textarea></label><button>Next</button></main>');
  mode = 'missing';
  result = await gateAdvance(ctx, 'Next');
  assert.ok(!result.proceed && result.result.kind === 'ok' && /CURRENT saved form/.test(result.result.message), 'actual employer-required fields still need completion');
  if (haiku) {
    ctx = await open('<main><p>Application unavailable.</p></main>');
    const { doFinish } = await import('./tools/finish.js');
    const stopped = await doFinish(ctx, { status: 'needs_human', reason: 'The form cannot be completed.' });
    assert.ok(stopped.kind === 'terminal' && stopped.outcome.status === 'skipped', 'Haiku can end an attempt without being forced to build an internal checklist or invent a candidate question');
  }

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

  ctx = await open(good); mode = 'unsupported';
  const repairsBefore = calls;
  duplicateProblems = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
    assert.ok(!result.proceed && result.result.kind === 'ok' && /Do not advance.*CURRENT saved form/s.test(result.result.message), 'a failed repair returns current-state feedback, not a counter-based stop');
    if (haiku) assert.match(result.result.kind === 'ok' ? result.result.message : '', /repair_feedback/);
    assert.equal(ctx.guards.ungrounded.length, 0, 'repeated model mistakes must not become a candidate question');
  }
  assert.equal(calls - repairsBefore, 3, 'each attempt has one current-form review and no extra candidate-question checker');
  duplicateProblems = false;
  mode = 'approve';
  result = await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
  assert.ok(!result.proceed && result.result.kind === 'terminal' && result.result.outcome.status === 'rehearsed', 'a successful later repair proceeds without an old strike veto');

  ctx = await open(good);
  duringReview = () => page.locator('#city').fill('Changed after review');
  result = await gateAdvance(ctx, 'Next');
  assert.ok(!result.proceed && result.result.kind === 'ok' && /changed during verification/.test(result.result.message));
  assert.equal(ctx.captured.length, 0, 'a stale approval is never recorded');
  for (const corrupt of ['wrong-ref', 'wrong-value', 'unavailable']) {
    ctx = await open(good); mode = corrupt;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await gateAdvance(ctx, 'Next');
      assert.ok(!result.proceed && result.result.kind === 'ok' && /could not run/.test(result.result.message), 'bad/unavailable reviews never advance and do not have a separate retry cutoff');
    }
    mode = 'approve';
    result = await gateAdvance(ctx, 'Next');
    assert.equal(result.proceed, true, 'a recovered reviewer can continue under the normal run limits');
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

  // Exercise the real saved-form gate + durable reservation + Submit control
  // at the URL that blocked run 518, with actual free-plan constraints.
  // Both destinations are fulfilled locally; no request reaches SEEK.
  let sends = 0;
  await page.route('https://au.seek.com/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/apply/success')) {
      sends++;
      return route.fulfill({ contentType: 'text/html', body: '<main><h1>Application sent</h1></main>' });
    }
    return route.fulfill({ contentType: 'text/html', body: '<main><form method="post" action="/job/95237902/apply/success"><label>Suburb *<input required value="Lidcombe"></label><button type="submit">Submit application</button></form></main>' });
  });
  ctx = await open(good);
  await page.goto('https://au.seek.com/job/95237902/apply/review');
  ctx.job = { ...ctx.job, id: '95237902', platform: 'seek', applicationMode: 'hosted', url: 'https://www.seek.com.au/job/95237902' };
  ctx.observation = await observe(page);
  config.dryRun = false;
  process.env.DRY_RUN = 'false';
  config.allowExternalApply = false;
  const journal = new ApplicationReservations(join(directory, 'free-plan'));
  try {
    const slots = new ApplicationSlots({ run: 1, day: 1, external: 0, appliedToday: () => 0, externalToday: 0 });
    const slot = (await slots.acquire(false))!;
    const id = journal.acquire(ctx.job)!;
    assert.ok(id);
    const gate = await withApplicationAttempt({ journal, id, job: ctx.job, beforeSubmit: slot.beforeSubmit }, () => gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true }));
    assert.equal(gate.proceed, true, 'free users must get past the actual Submit gate on au.seek.com');
    assert.equal(journal.state(id), 'pending', 'record uncertainty before the browser can send');
    await page.getByRole('button', { name: 'Submit application', exact: true }).click();
    await page.waitForURL('**/apply/success');
    assert.equal(await detectConfirmation(page), true);
    assert.equal(sends, 1);
    journal.finish(id, { status: 'applied', jobId: ctx.job.id, at: new Date().toISOString() });
    slot.finish(true);
    assert.equal(await slots.acquire(false), null, 'the final free application cannot be spent twice');
    assert.deepEqual(journal.unrecordedToday([]), { applications: 1, external: 0 });
  } finally { journal.close(); }
  console.log('PASS: free-plan browser submission on au.seek.com, current saved-form verification, durable pending marker, dedicated receipt and last-credit limit; all network responses mocked.');
  console.log('PASS: current-form authority, stale checklist repair, one review, invalid unchanged values, required blanks, missing facts, changed-state expiry, corrupt/outage fail-closed recovery without strike cutoffs, frames/shadow roots, private values and dry-run protection.');
} finally {
  await browser.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-saved-form-'));
  rmSync(directory, { recursive: true, force: true });
}
