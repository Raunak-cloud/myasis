/** Real isolated DOM + shared wire/send guards; every provider reply is mocked.
 * Never launches an application worker or reaches an employer/provider. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Route } from 'patchright';
import type { ToolContext } from './tools/context.js';

const owner = `readiness-gate-fixture-${randomUUID()}`;
const directory = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'data', 'users', owner);
mkdirSync(resolve(directory, 'resumes'), { recursive: true });
writeFileSync(resolve(directory, 'resumes', 'Approved fictional CV.txt'), 'Fictional candidate only.');
writeFileSync(resolve(directory, 'resumes.json'), JSON.stringify([{ id: 'fictional-cv', label: 'Approved fictional CV',
  fileName: 'Approved fictional CV.txt', seekName: 'Approved fictional CV.txt', uploadedAt: '2026-01-01T00:00:00Z', size: 25, isDefault: true }]));
Object.assign(process.env, { APPLICATION_AI_MODEL: 'haiku', APPLICATION_AI_ADMIN_ENABLED: 'true', APPLICATION_AI_OWNER_ID: owner,
  APPLICATION_AI_FORM_REVIEW_MODE: 'agent-managed', ANTHROPIC_API_KEY: 'fictional-offline-key', CELERIS_API_KEY: 'fictional-offline-key',
  OPENROUTER_API_KEY: '', DATA_DIR: directory, DRY_RUN: 'true', ALLOW_EXTERNAL_APPLY: 'true', COST_TRACKING: 'false',
  HUMANIZER_MODE: 'off', HUMANIZER_REQUIRED: 'false' });
const { gateAdvance } = await import('./tools/gate.js');
const { observe } = await import('./observe.js');
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');
const { guardedBrowserAction } = await import('./raw-tools.js');
const { config } = await import('../config.js');
const originalFetch = globalThis.fetch;
let classifications = 0, reviews = 0, receiptChecks = 0, receipt = false;
globalThis.fetch = (async (url, init) => {
  assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
  const body = JSON.parse(String(init?.body)), properties = body.output_config?.format?.schema?.properties ?? {};
  let answer: unknown;
  if (properties.sends_application) {
    classifications++;
    const prompt = JSON.stringify(body.messages);
    answer = { sends_application: !prompt.includes('privacy-consent-dialog') };
  } else if (properties.problems) { reviews++; answer = { problems: [] }; }
  else if (properties.confirmed) { receiptChecks++; answer = { confirmed: receipt, quote: receipt ? 'Application received for fictional vacancy' : '', reason: 'Fictional fixture evidence only.' }; }
  else throw new Error('Unexpected provider operation in offline gate fixture.');
  return Response.json({ id: 'msg_offline_gate', model: 'claude-haiku-5-5', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 40, output_tokens: 20 } });
}) as typeof fetch;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH }
  : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
after(async () => { globalThis.fetch = originalFetch; await browser.close(); rmSync(directory, { recursive: true, force: true }); });
const profile = { name: 'Alex Taylor', email: 'alex@example.test', phone: '', state: 'NSW', suburb: 'Lidcombe', nationality: '',
  expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' };
const markup = `<main><h1>Fictional application</h1><label>Name<input id="name" value="Alex Taylor" required></label>
<label>State/Province<input id="state" value="NSW" required></label><label>Unknown licence<input required></label>
<label>Resume<select id="resume"><option>Other document.txt</option><option>Approved fictional CV.txt</option></select></label>
<label>Cover letter<textarea id="letter"></textarea></label><label>Password<input type="password" value="FICTIONAL_SECRET"></label>
<button id="submit" type="button" onclick="document.body.dataset.sendCount=String(Number(document.body.dataset.sendCount||0)+1)">Submit application</button></main>`;
async function fixture(id: string, board = false, html = markup) {
  const context = await browser.newContext({ serviceWorkers: 'block' }); let postRequests = 0;
  const host = board ? 'www.seek.com.au' : 'readiness.fixture.invalid';
  await context.route('**/*', route => {
    const request = route.request();
    if (request.method() === 'POST') postRequests++;
    return new URL(request.url()).hostname === host
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort('blockedbyclient');
  });
  const page = await context.newPage(); await page.goto(`https://${host}/fixture/${id}`);
  const ctx: ToolContext = { architecture: 'compact', nativeBrowserActionsOnly: true, nativeFormReadiness: 'agent-managed', page,
    job: { id: `fixture-${id}`, title: 'Fictional retail assistant', company: 'Fixture employer', location: 'Sydney NSW', url: page.url() },
    profile, observation: await observe(page), captured: [], actions: [], log: () => {},
    guards: new RunGuards({ maxSteps: 20, maxStepsPerPage: 10, maxStuckMs: 60_000, maxTotalMs: 120_000, meter: new CostMeter(1) }) };
  return { page, context, ctx, postRequests: () => postRequests };
}

test('agent-managed Continue skips every readiness/document veto; standard native mode keeps them', async () => {
  const f = await fixture('early-step', true); const before = { classifications, reviews };
  try {
    f.ctx.declaredSubmit = false;
    assert.deepEqual(await gateAdvance(f.ctx, 'Continue'), { proceed: true, submit: false });
    assert.deepEqual({ classifications, reviews }, before);
    assert.equal(await f.page.locator('#resume').inputValue(), 'Other document.txt');
    assert.equal(f.ctx.resumeSettled, undefined);
    f.ctx.nativeFormReadiness = 'standard';
    const held = await gateAdvance(f.ctx, 'Continue');
    assert.equal(held.proceed, false);
    assert.equal(!held.proceed && held.result.kind === 'ok' && held.result.disposition, 'document-prerequisite');
    assert.equal(await f.page.locator('#resume').inputValue(), 'Other document.txt');
  } finally { await f.context.close(); }
});

test('two Save controls with equal counts use their own dialog context and never share a verdict', async () => {
  const f = await fixture('privacy-step'); const before = { classifications, reviews };
  try {
    const decision = await gateAdvance(f.ctx, 'Save', 'privacy-consent-dialog: saves consent preference, not the application');
    assert.deepEqual(decision, { proceed: true, submit: false });
    assert.equal(classifications, before.classifications + 1); assert.equal(reviews, before.reviews);
    assert.equal(f.ctx.submissionAttempted, undefined);
    const final = await gateAdvance(f.ctx, 'Save', 'final-review-dialog: sends this application to the employer');
    assert.equal(!final.proceed && final.result.kind === 'terminal' && final.result.outcome.status, 'rehearsed');
    assert.equal(classifications, before.classifications + 2); assert.equal(reviews, before.reviews);
    assert.equal(f.ctx.submissionAttempted, undefined);
  } finally { await f.context.close(); }
});

test('pilot final send stays dry-run, records actual nonsecret values and performs zero readiness reviews', async () => {
  const f = await fixture('dry-run'); const before = { classifications, reviews };
  try {
    f.ctx.captured.push({ question: 'Name', answer: 'Superseded draft' });
    const decision = await gateAdvance(f.ctx, 'Submit application', undefined, { knownSubmit: true });
    assert.equal(decision.proceed, false);
    assert.equal(!decision.proceed && decision.result.kind === 'terminal' && decision.result.outcome.status, 'rehearsed');
    assert.equal(f.ctx.captured.find(answer => answer.question === 'Name')?.answer, profile.name);
    assert.equal(f.ctx.captured.find(answer => answer.question === 'State/Province')?.answer, profile.state);
    assert.doesNotMatch(JSON.stringify(f.ctx.captured), /FICTIONAL_SECRET|Superseded draft/);
    assert.equal(f.ctx.submissionAttempted, undefined);
    assert.equal(await f.page.evaluate(() => Number(document.body.dataset.sendCount ?? 0)), 0);
    assert.deepEqual({ classifications, reviews }, before);
  } finally { await f.context.close(); }
});

test('external policy and destructive board-account protection remain active in pilot', async () => {
  const f = await fixture('external-disabled'); const previous = config.allowExternalApply;
  try {
    config.allowExternalApply = false;
    const decision = await gateAdvance(f.ctx, 'Submit application', undefined, { knownSubmit: true });
    assert.equal(!decision.proceed && decision.result.kind === 'terminal' && decision.result.outcome.status, 'off-platform');
    assert.equal(f.ctx.submissionAttempted, undefined);
  } finally { config.allowExternalApply = previous; await f.context.close(); }
  const b = await fixture('protected-board', true);
  try {
    const held = await gateAdvance(b.ctx, 'Delete saved resume');
    assert.equal(held.proceed, false);
    assert.match(!held.proceed && held.result.kind === 'ok' ? held.result.message : '', /may be deleted or removed/);
  } finally { await b.context.close(); }
});

test('a forged pilot context under Celeris cannot bypass the standard readiness gate', async () => {
  const f = await fixture('forged-context'), previous = process.env.APPLICATION_AI_MODEL;
  try {
    process.env.APPLICATION_AI_MODEL = 'celeris';
    const held = await gateAdvance(f.ctx, 'Submit application', undefined, { knownSubmit: true });
    assert.equal(!held.proceed && held.result.kind === 'ok' && held.result.disposition, 'document-prerequisite');
    assert.equal(f.ctx.submissionAttempted, undefined);
  } finally { process.env.APPLICATION_AI_MODEL = previous; await f.context.close(); }
});

test('one possible send blocks every repeat; only an independent receipt can confirm success', async () => {
  const f = await fixture('single-send'), previous = config.dryRun;
  try {
    config.dryRun = false; process.env.DRY_RUN = 'false'; receipt = false;
    assert.deepEqual(await gateAdvance(f.ctx, 'Submit application', undefined, { knownSubmit: true }), { proceed: true, submit: true });
    await f.page.locator('#submit').click();
    assert.equal(f.ctx.submissionAttempted, true);
    const before = receiptChecks, repeat = await gateAdvance(f.ctx, 'Submit application', undefined, { knownSubmit: true });
    assert.equal(repeat.proceed, false); assert.equal(receiptChecks, before + 1);
    assert.match(!repeat.proceed && repeat.result.kind === 'ok' ? repeat.result.message : '', /no repeat send/);
    assert.equal(await f.page.evaluate(() => Number(document.body.dataset.sendCount ?? 0)), 1);
    receipt = true;
    await f.page.evaluate(() => { const note = document.createElement('p'); note.textContent = 'Application received for fictional vacancy'; document.body.append(note); });
    const confirmed = await gateAdvance(f.ctx, 'Submit application', undefined, { knownSubmit: true });
    assert.equal(!confirmed.proceed && confirmed.result.kind === 'terminal' && confirmed.result.outcome.status, 'applied');
    assert.equal(await f.page.evaluate(() => Number(document.body.dataset.sendCount ?? 0)), 1);
  } finally { receipt = false; config.dryRun = previous; process.env.DRY_RUN = 'true'; await f.context.close(); }
});

test('wire-level fallback honors pilot dry-run and still blocks cross-site private-data requests', async () => {
  const f = await fixture('network-fallback');
  const originalRoute = f.context.route, originalUnroute = f.context.unroute;
  let handler: ((route: Route) => Promise<void>) | undefined, delivered = 0, aborted = 0;
  // Exercise the actual production route callback with real page/context
  // state, without a pending navigation replacing that state mid-audit.
  f.context.route = (async (_url: unknown, callback: unknown) => { handler = callback as typeof handler; }) as unknown as typeof f.context.route;
  f.context.unroute = (async () => {}) as typeof f.context.unroute;
  const request = (url: string, body: string, navigation: boolean) => ({
    request: () => ({ url: () => url, postData: () => body, method: () => 'POST', isNavigationRequest: () => navigation }),
    abort: async () => { aborted++; }, fallback: async () => { delivered++; },
  }) as unknown as Route;
  try {
    const result = await guardedBrowserAction(f.ctx, 'unclassified form post', async () => {
      assert.ok(handler);
      await handler(request('https://readiness.fixture.invalid/fixture/received', 'name=Alex', true));
      return { kind: 'ok', message: 'Local fixture post attempted.' };
    });
    assert.equal(result.kind === 'terminal' && result.outcome.status, 'rehearsed', JSON.stringify(result));
    assert.equal(delivered, 0); assert.equal(aborted, 1); assert.equal(f.ctx.submissionAttempted, undefined);
    const refusal = await guardedBrowserAction(f.ctx, 'private-data request', async () => {
      assert.ok(handler);
      await handler(request('https://outside-privacy.invalid/collect', profile.email, false));
      return { kind: 'ok', message: 'Local privacy fixture complete.' };
    });
    assert.match(refusal.kind === 'ok' ? refusal.message : '', /Refused by the browser guard/);
    assert.equal(delivered, 0); assert.equal(aborted, 2);
  } finally { f.context.route = originalRoute; f.context.unroute = originalUnroute; await f.context.close(); }
});
