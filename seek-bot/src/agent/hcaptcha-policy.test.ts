import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { ToolContext } from './tools/context.js';

// All pages, model responses and provider requests are intercepted locally.
const directory = mkdtempSync(join(tmpdir(), 'owtomate-hcaptcha-policy-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', DRY_RUN: 'false',
  ALLOW_EXTERNAL_APPLY: 'true', CAPTCHA_SOLVER: 'capmonster', CAPMONSTER_API_KEY: 'fixture-only' });
writeFileSync(join(directory, 'approved-applications.json'), '[]');
const { runApplicationAgent } = await import('./loop.js');
const { hasHcaptchaChallenge } = await import('../captcha/detect.js');
const { handleCaptchaWithCapMonster, trySolveCaptcha, HCAPTCHA_SKIP_REASON } = await import('../captcha.js');
const { waitForChallengeToClear } = await import('../browser.js');
const { executeTool } = await import('./tools.js');
const { doFinish } = await import('./tools/finish.js');
const { fillObservedFields } = await import('./field-batch.js');
const { observe } = await import('./observe.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch;
let modelCalls = 0;
let reply: () => Array<{ name: string; args: Record<string, unknown> }> = () => { throw new Error('Unexpected model call'); };
globalThis.fetch = async (url) => {
  assert.match(String(url), /celeris/, 'hCaptcha must never create a paid solver request');
  modelCalls++;
  return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: reply().map((call, index) => ({ id: `t${modelCalls}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
};
const checkbox = '<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox" style="width:303px;height:78px;border:0"></iframe>';
const profile = { name: 'Fixture Candidate', email: 'fixture@example.invalid', skills: [] } as never;
const job = { id: 'hcaptcha-fixture', title: 'Assistant', company: 'Fixture', location: 'Sydney', url: 'https://employer.fixture.invalid/apply' } as never;
const skipped = (result: { kind: string; outcome?: { status: string; reason?: string } }) => {
  assert.equal(result.kind, 'terminal');
  assert.equal(result.outcome?.status, 'skipped');
  assert.equal(result.outcome?.reason, HCAPTCHA_SKIP_REASON);
};
try {
  const context = await browser.newContext();
  let html = '';
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
    new URL(route.request().url()).hostname.includes('hcaptcha.com') ? '<main>Offline challenge fixture</main>'
    : new URL(route.request().url()).hostname === 'embedded.fixture.invalid' ? checkbox : html }));
  const page = await context.newPage();
  const load = async (content: string) => { html = `<main>${content}</main>`; await page.goto('https://employer.fixture.invalid/apply'); };
  for (const mode of ['', 'prepare', 'approved']) {
    process.env.APPLICATION_REVIEW_MODE = mode;
    for (const surface of [checkbox, '<iframe src="https://embedded.fixture.invalid/form" style="width:600px;height:300px"></iframe>']) {
      await load(`<label>Name<input id=name></label>${surface}<button>Submit</button>`);
      const before = modelCalls;
      assert.equal(await hasHcaptchaChallenge(page), true);
      const result = await runApplicationAgent({ page, job, profile, log: () => {} });
      assert.equal(result.outcome.status, 'skipped');
      assert.equal((result.outcome as { reason: string }).reason, HCAPTCHA_SKIP_REASON);
      assert.equal(result.submitPressed, false);
      assert.equal(result.steps, 0);
      assert.equal(modelCalls, before, 'visible hCaptcha stops before any model or solver request');
      assert.equal(await page.inputValue('#name'), '');
    }
  }
  process.env.APPLICATION_REVIEW_MODE = '';
  await load(checkbox);
  assert.equal(await handleCaptchaWithCapMonster(page), 'hcaptcha');
  assert.equal(await trySolveCaptcha(page), false);
  const started = performance.now();
  assert.equal(await waitForChallengeToClear(page, 45_000), false);
  assert.ok(performance.now() - started < 5_000, 'hCaptcha does not consume the normal verification wait');
  skipped(await executeTool({ page } as ToolContext, 'snapshot', {}));
  skipped(await doFinish({ page } as ToolContext, { status: 'needs_human', reason: 'hCaptcha' }));

  // A challenge appearing after an action stops all later actions in that model response.
  for (const sends of [false, true]) {
    await load(`<label>Name<input id=name></label><div id=challenge style="display:none">${checkbox}</div>
      <button onclick="document.querySelector('#challenge').style.display='block'">Continue</button>`);
    const before = modelCalls;
    reply = () => [{ name: 'browser_action', args: { action: 'click', selector: 'button', sends_application: sends } },
      { name: 'browser_action', args: { action: 'fill', selector: '#name', value: 'Must not be written' } }];
    const result = await runApplicationAgent({ page, job, profile, log: () => {} });
    assert.equal(result.outcome.status, 'skipped');
    assert.equal((result.outcome as { reason: string }).reason, HCAPTCHA_SKIP_REASON);
    assert.equal(result.submitPressed, sends, 'a prior send press remains visible for reconciliation');
    assert.equal(modelCalls - before, 1, 'no extra reasoning or recovery request after the challenge');
    assert.equal(await page.inputValue('#name'), '');
  }

  await load(`<label>First<input id=first oninput="document.querySelector('#challenge').style.display='block'"></label>
    <label>Second<input id=second></label><div id=challenge style="display:none">${checkbox}</div>`);
  const ctx = { page, observation: await observe(page), captured: [], actions: [] } as unknown as ToolContext;
  const batchResult = await fillObservedFields(ctx, [{ ref: 'f0', value: 'First answer' }, { ref: 'f1', value: 'Must stay blank' }]);
  skipped(batchResult);
  assert.equal(await page.inputValue('#first'), 'First answer');
  assert.equal(await page.inputValue('#second'), '', 'batch transport stops as soon as hCaptcha appears');

  // A hidden invisible widget is not an active challenge and does not block ordinary applications.
  await load(`<div style="display:none">${checkbox}</div><label>Name<input id=name></label>`);
  assert.equal(await hasHcaptchaChallenge(page), false);
  const before = modelCalls;
  reply = () => [{ name: 'finish', args: { status: 'skipped', reason: 'Fixture complete', evidence: 'No visible challenge' } }];
  const hidden = await runApplicationAgent({ page, job, profile, log: () => {} });
  assert.equal(modelCalls - before, 1);
  assert.notEqual((hidden.outcome as { reason: string }).reason, HCAPTCHA_SKIP_REASON);
  assert.equal(page.isClosed(), false);
  console.log('PASS: hCaptcha skips Auto/Semi auto/confirmation before model calls; nested frames, action and submit races, batch interruption, no solver requests, no challenge wait, hidden-widget compatibility; native offline fixtures only.');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  assert.ok(directory.startsWith(join(tmpdir(), 'owtomate-hcaptcha-policy-')));
  rmSync(directory, { recursive: true, force: true });
}
