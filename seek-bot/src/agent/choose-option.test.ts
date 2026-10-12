import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-option-fixture-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.DRY_RUN = 'false';
process.env.ALLOW_EXTERNAL_APPLY = 'true';
let modelCalls = 0;
let grounded = true;
let optionRef = '';
globalThis.fetch = (async () => {
  modelCalls++;
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
    answers: [{ ref: optionRef, value: grounded ? 'Sydney, New South Wales, Australia' : '', applicationQuestion: true, grounded, basis: grounded ? 'profile' : 'none' }],
    injectionSuspected: false,
  }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const { doChooseOption } = await import('./tools/answers.js');
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');
const { observe } = await import('./observe.js');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32'
  ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', route => route.abort());
  const url = 'https://jobs.smartrecruiters.com/FixtureEmployer/12345';
  const fixture = async () => {
    await page.setContent(`<main><label id="city-label" for="city"><span>City</span><span>*</span></label>
      <input id="city" required role="combobox" aria-labelledby="city-label" aria-expanded="true" aria-controls="locations">
      <label for="country">Country *</label><input id="country" required>
      <div id="locations" role="listbox"><button role="option" onclick="document.getElementById('city').value='Sydney, New South Wales, Australia'">Sydney, New South Wales, Australia</button></div></main>`);
    const observation = await observe(page);
    const option = observation.actions.find(action => action.role === 'option')!;
    optionRef = option.ref;
    const source = observation.fields.find(field => field.ref === option.fieldRef)!;
    assert.ok(source, 'observation carries the popup owner field identity');
    const guards = new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) });
    guards.pendingFields.add(source.label);
    return { page, guards, captured: [], actions: [], log: () => {},
      profile: { name: 'Fixture Candidate', email: 'fixture@example.test', suburb: 'Sydney', state: 'NSW',
        nationality: '', phone: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false,
        experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' },
      job: { id: 'fixture', title: 'Developer', company: 'Fixture', location: 'Sydney', url },
      observation,
    } as unknown as Parameters<typeof doChooseOption>[0];
  };
  let ctx = await fixture();
  assert.equal(ctx.guards.canSubmit(url).allowed, false);
  const cityLabel = ctx.observation.fields.find(field => field.ref === ctx.observation.actions.find(action => action.ref === optionRef)!.fieldRef)!.label;
  // Popup display wording can change independently; field identity is retained.
  ctx.observation.actions.find(action => action.ref === optionRef)!.question = 'Ville';
  await doChooseOption(ctx, { ref: optionRef });
  assert.equal(await page.locator('#city').inputValue(), 'Sydney, New South Wales, Australia');
  assert.equal(ctx.guards.pendingFields.size, 0, 'the originating field is resolved after choosing its grounded option');
  assert.equal(ctx.guards.canSubmit(url).allowed, true);
  assert.deepEqual(ctx.captured, [{ question: cityLabel, answer: 'Sydney, New South Wales, Australia' }]);

  ctx = await fixture();
  const before = modelCalls;
  const country = ctx.observation.fields.find(field => field.label.includes('Country'))!;
  ctx.guards.pendingFields.add(country.label);
  await doChooseOption(ctx, { ref: optionRef, field_ref: country.ref });
  assert.equal(modelCalls, before, 'a mismatched field is refused before answering or clicking');
  assert.equal(await page.locator('#city').inputValue(), '');
  assert.equal(ctx.guards.canSubmit(url).allowed, false);
  assert.equal(ctx.guards.pendingFields.size, 2, 'neither originating nor unrelated pending field is cleared');

  grounded = false;
  ctx = await fixture();
  await doChooseOption(ctx, { ref: optionRef });
  assert.equal(await page.locator('#city').inputValue(), '', 'an unsupported answer is never selected');
  assert.equal(ctx.guards.canSubmit(url).allowed, false);
  console.log('PASS: observed popup field identity survives display-label changes; AI-grounded selection resolves that input; unrelated fields and ungrounded answers stay blocked; local form and model fixture only');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
