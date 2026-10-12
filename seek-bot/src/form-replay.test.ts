import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'patchright';

/**
 * A real-looking employer page is recorded into the corpus as the agent sees
 * it, renders the same offline (form state and an external stylesheet kept,
 * scripts gone), replays clean against the same code, and a replay that
 * reads it worse fails.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-corpus-'));
process.env.FORM_CORPUS_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
const { recordFormPage } = await import('./form-corpus.js');
const { observe } = await import('./agent/observe.js');

const form = `<!doctype html><html><head><link rel="stylesheet" href="https://cdn.workday-fixture.example/app.css">
  <script>window.tracking = true;</script></head><body><main><h1>My Information</h1><form class="entrance">
  <label for="g">Given Name *</label><input id="g" name="legalName--firstName" required>
  <label for="c">Country</label><select id="c" name="country"><option>Australia</option><option>New Zealand</option></select>
  <div class="hidden-by-css"><label>Internal code <input name="internal"></label></div>
  <label><input type="checkbox" name="terms"> I agree to the terms</label>
  <p>Attach a cover letter if you like.</p><button type="button">Upload cover letter</button>
  <button type="button">Save and Continue</button></form></main>
  <chat-widget></chat-widget>
  <script>customElements.define('chat-widget', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div><label>Write a reply <textarea name="reply"></textarea></label></div>'; } });</script>
  </body></html>`;
const css = '.hidden-by-css { display: none; } .entrance { animation: fade 1s 10s both; } @keyframes fade { from { opacity: 0; } to { opacity: 1; } }';

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  await page.route('https://acme.wd3.myworkdayjobs-fixture.example/**', (route) => route.fulfill({ contentType: 'text/html', body: form }));
  await page.route('https://cdn.workday-fixture.example/**', (route) => route.fulfill({ contentType: 'text/css', body: css }));
  // The step lives after "#", as on ELMO and Cornerstone: it never reaches the network, and the replay must still serve the page.
  await page.goto('https://acme.wd3.myworkdayjobs-fixture.example/job/apply/1#/step2?jobAdId=1');
  // The live snapshot is taken after the entrance; offline rendering must
  // reach the same state without waiting for a site's arbitrary animation delay.
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await page.fill('input[name="legalName--firstName"]', 'Raunak');
  await page.selectOption('select', 'New Zealand');
  await page.check('input[name="terms"]');
  /**
   * A page caught mid-change is not recorded: a field the observation read is
   * gone by the time of the snapshot (Workday swapping its dialogs), so the
   * recording would expect a field its own snapshot does not hold.
   */
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="leaving"><label for="o">Old password</label><input id="o" name="old"></div>'));
  const changing = await observe(page);
  await page.evaluate(() => document.getElementById('leaving')?.remove());
  await recordFormPage(page, changing);
  assert.equal(readdirSync(directory).length, 0, 'a page whose fields changed under the snapshot is not recorded');

  const observation = await observe(page);
  assert.ok(!observation.fields.some((field) => /internal code/i.test(field.label)), 'the field hidden by the stylesheet is not observed live');
  assert.ok(observation.fields.some((field) => /write a reply/i.test(field.label)), 'the field inside a shadow root is observed live');
  await recordFormPage(page, observation);
  await recordFormPage(page, observation); // the same page twice is kept once

  const platformDir = join(directory, 'Workday');
  const files = readdirSync(platformDir);
  assert.equal(files.filter((name) => name.endsWith('.json')).length, 1, 'one page, recorded once, under its platform');
  const expectation = JSON.parse(readFileSync(join(platformDir, files.find((name) => name.endsWith('.json'))!), 'utf8'));
  assert.equal(expectation.platform, 'Workday');
  assert.equal(expectation.coverLetterOffered, true);

  const replay = () => spawnSync(process.execPath, [resolve('dist/form-replay.js'), directory], { encoding: 'utf8' });
  let run = replay();
  assert.equal(run.status, 0, `the page replays clean against the same code:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Replayed 1\/1: 0 regression/);

  // A reading that has got worse is a regression: a field that is no longer found.
  const jsonPath = join(platformDir, files.find((name) => name.endsWith('.json'))!);
  const worse = { ...expectation, fields: [...expectation.fields, { label: 'Middle Name', kind: 'text', required: false, options: 0 }] };
  writeFileSync(jsonPath, JSON.stringify(worse));
  run = replay();
  assert.equal(run.status, 1, 'a field no longer found fails the replay');
  assert.match(run.stdout, /✗ .*fields found: \d+ → \d+/);

  console.log('PASS: real form pages are recorded once and only when stable, replay offline with their state, styles, shadow roots and in-page step address, and a worse reading fails the replay');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
