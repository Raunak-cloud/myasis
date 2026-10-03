import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'patchright';

/**
 * No control on an employer form is unreachable by every tool, and no gate
 * holds an application for good. Each case here is a form that lost a real
 * application on 3 Oct 2026 by trapping the agent in a loop until the page's
 * step budget ran out.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-dead-ends-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ problems: [], sends_application: false, unsafe: false, reason: 'fixture' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const { observe } = await import('./observe.js');
const { executeTool } = await import('./tools.js');
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');
const { recordWall, walledHost } = await import('../site-walls.js');

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page: Page = await browser.newPage();
  let html = '';
  await page.route('https://go.programmed.example/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  const profile = { name: 'Raunak Shrestha', phone: '0400000000', email: 'raunak@example.com', nationality: 'Nepali', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '', suburb: 'Parramatta' };
  const open = async (body: string) => {
    html = body;
    await page.goto('https://go.programmed.example/job/apply/1');
    const ctx = {
      page, profile,
      job: { id: '1', title: 'Front End Developer', company: 'PERSOL', location: 'Sydney', url: 'https://go.programmed.example/job/apply/1' },
      observation: await observe(page), captured: [], actions: [], log: (line: string) => logged.push(line),
      guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) }),
    } as unknown as Parameters<typeof executeTool>[0] & { coverLetterOffered?: boolean; coverLetterHeld?: number; guards: InstanceType<typeof RunGuards> };
    return ctx;
  };
  const logged: string[] = [];
  const message = (result: Awaited<ReturnType<typeof executeTool>>) => (result as { message?: string }).message ?? '';

  // 1. A site control the answer model declined is operable by the general tools.
  const picker = `<!doctype html><main><form>
    <label>Enter First Name <input name="first"></label>
    <div role="dialog"><label>Search by city <input name="city" placeholder="Search by city"></label></div>
    <button type="button">Next</button></form></main>`;
  let ctx = await open(picker);
  const city = ctx.observation.fields.find((field) => /search by city/i.test(field.label));
  assert.ok(city, 'the search box is observed as a field');
  let result = await executeTool(ctx, 'fill_element', { ref: city!.ref, value: 'Parramatta' });
  assert.match(message(result), /use answer_questions/i, 'before being declined, the grounded tool owns the field');
  ctx.guards.releaseAsSiteControl(city!.label);
  result = await executeTool(ctx, 'fill_element', { ref: city!.ref, value: 'Parramatta' });
  assert.doesNotMatch(message(result), /use answer_questions/i, message(result));
  assert.equal(await page.inputValue('input[name=city]'), 'Parramatta', 'the general tool filled the released control');

  // 2. The cover-letter hold lets go: once for a mere mention, so a form with no place for a letter still goes on.
  const mention = `<!doctype html><main><form>
    <p>Applications with a cover letter are welcome.</p>
    <label>Enter First Name <input name="first" value="Raunak"></label>
    <button type="button" onclick="document.body.insertAdjacentHTML('beforeend', '<p id=next>Next page</p>')">Next</button></form></main>`;
  ctx = await open(mention);
  ctx.coverLetterOffered = true;
  const next = ctx.observation.actions.find((action) => /^next$/i.test(action.text));
  assert.ok(next, 'the fixture has a Next action');
  result = await executeTool(ctx, 'click', { ref: next!.ref, reason: 'Next step' });
  assert.match(message(result), /do not advance yet/i, 'held once so the agent looks for the letter');
  assert.equal(await page.locator('#next').count(), 0);
  ctx.observation = await observe(page);
  result = await executeTool(ctx, 'click', { ref: next!.ref, reason: 'Next step, no letter box found' });
  assert.equal(await page.locator('#next').count(), 1, 'the second press goes through');
  assert.ok(logged.some((line) => /no cover letter: the page mentions one but has no place for it/.test(line)), logged.join(' | '));

  // 3. A site whose check stopped an application is remembered for the day.
  assert.equal(walledHost('jobs.lever.co'), null);
  recordWall('jobs.lever.co', 'The site security verification could not be cleared automatically.');
  assert.match(walledHost('jobs.lever.co')?.reason ?? '', /security verification/);
  assert.equal(walledHost('careers.example.com'), null, 'other sites are untouched');

  console.log('PASS: declined site controls are operable, the cover-letter hold lets go, and a walled site is remembered');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
