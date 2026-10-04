import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

/**
 * The submit gate on a form that keeps one address for the whole flow
 * (SAP SuccessFactors): "Apply" at the start opens the form; "Apply" once the
 * form is filled sends it, and in a rehearsal it must be withheld. On 4 Oct a
 * verdict cached for the first was reused for the second and a rehearsal sent
 * Nestlé a real application.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-submit-gate-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.DRY_RUN = 'true';
process.env.ALLOW_EXTERNAL_APPLY = 'true';
// The model would call "Apply" not a submit both times; the gate must not rely on it.
let modelCalls = 0;
globalThis.fetch = (async () => (modelCalls++, new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ sends_application: false, problems: [], unsafe: false, reason: 'fixture' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))) as typeof fetch;
const { observe } = await import('./observe.js');
const { executeTool } = await import('./tools.js');
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  let html = '<!doctype html><main><h1>Job</h1><button type="button" onclick="document.title=\'opened\'">Apply</button></main>';
  await page.route('https://career2.successfactors-fixture.example/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://career2.successfactors-fixture.example/portalcareer');
  const ctx = {
    page,
    profile: { name: 'Raunak Shrestha', phone: '0400000000', email: 'r@example.com', nationality: 'Nepali', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' },
    job: { id: 'sf-1', title: 'Analyst', company: 'Fixture', location: 'Sydney', url: 'https://career2.successfactors-fixture.example/portalcareer' },
    observation: await observe(page), captured: [] as Array<{ question: string; answer: string }>, actions: [], log: () => {},
    guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) }),
  } as unknown as Parameters<typeof executeTool>[0];
  const applyRef = () => ctx.observation.actions.find((action) => /^apply$/i.test(action.text))!.ref;

  // At the start, with nothing entered, "Apply" opens the form.
  let result = await executeTool(ctx, 'click', { ref: applyRef(), reason: 'start' });
  assert.equal(result.kind, 'ok', 'opening the form is not a submit');
  assert.equal(await page.title(), 'opened');

  // Same address, form now filled: "Apply" is the submit, withheld in a rehearsal.
  html = '<!doctype html><main><h1>Job</h1><form><label>First name <input value="Raunak"></label><button type="button" onclick="document.title=\'SENT\'">Apply</button></form></main>';
  await page.goto('https://career2.successfactors-fixture.example/portalcareer');
  ctx.observation = await observe(page);
  ctx.captured.push({ question: 'First name', answer: 'Raunak' });
  result = await executeTool(ctx, 'click', { ref: applyRef(), reason: 'submit', no_cover_letter_place: 'the form has no letter box or upload' });
  assert.notEqual(await page.title(), 'SENT', 'the filled form was not sent');
  assert.equal(result.kind, 'terminal');
  assert.equal(result.kind === 'terminal' && result.outcome.status, 'rehearsed', 'the rehearsal ends at the withheld submit');
  // The agent's own judgement decides a press no word would give away, with no separate model call.
  html = `<!doctype html><main><form><label>First name <input value="Raunak"></label><button type="button" onclick="document.title='SENT'">Proceed</button></form></main>`;
  await page.goto('https://career2.successfactors-fixture.example/portalcareer');
  ctx.observation = await observe(page);
  const before = modelCalls;
  const proceed = ctx.observation.actions.find((action) => /^proceed$/i.test(action.text))!.ref;
  result = await executeTool(ctx, 'click', { ref: proceed, reason: 'send it', sends_application: true, no_cover_letter_place: 'the form has no letter box or upload' });
  assert.notEqual(await page.title(), 'SENT', 'what the agent says is the submit is gated as one');
  assert.equal(result.kind === 'terminal' && result.outcome.status, 'rehearsed');
  assert.equal(modelCalls - before, 0, 'no separate model call was needed to judge it');
  console.log("PASS: a control that opened a form is still gated as the submit once the form is filled, the agent's own submit judgement is used without another model call, and a rehearsal never sends");
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
