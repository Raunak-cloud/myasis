import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');

// Bundle only this component and fixture. No dashboard server, database,
// candidate account, run or employer service is started or contacted.
const result = await build({ configFile: false, root: resolve(import.meta.dirname, '..'), plugins: [react()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error', build: { write: false, minify: false, lib: { entry: resolve(import.meta.dirname, 'attention-form.fixture.tsx'), formats: ['iife'], name: 'AttentionFormFixture' } } });
const bundle = (Array.isArray(result) ? result : [result]).flatMap(value => 'output' in value ? value.output : []).find(value => value.type === 'chunk');
assert.ok(bundle && bundle.type === 'chunk');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  res.end(req.url === '/fixture.js' ? bundle.code : '<div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
  const page = await browser.newPage();
  page.on('pageerror', error => { console.error(error.message); });
  const writes: Array<{ jobId: string; answers: Array<{ question: string; prompt: string; answer: string }> }> = [];
  let mode = 'failed';
  let release: (() => void) | undefined;
  let holdStarted: (() => void) | undefined;
  await page.route('**/api/answers', async route => {
    const body = route.request().postDataJSON(); writes.push(body);
    if (mode === 'held') await new Promise<void>(done => { release = done; holdStarted?.(); });
    await route.fulfill({ status: mode === 'failed' ? 503 : 200, contentType: 'application/json', body: mode === 'failed' ? JSON.stringify({ error: 'Could not save the answers. Please try again.' }) : JSON.stringify({ ok: true, saved: mode === 'malformed' ? 0 : body.answers.length }) });
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  const notice = page.getByRole('textbox', { name: 'What is your notice period?', exact: true });
  const reason = page.getByRole('textbox', { name: 'Why do you want this role?', exact: true });
  await notice.fill('Two weeks'); await reason.fill('Relevant work');
  await page.getByRole('button', { name: 'Save answers', exact: true }).click();
  await page.getByText('Could not save the answers. Please try again.', { exact: true }).waitFor();
  assert.equal(await notice.inputValue(), 'Two weeks'); assert.equal(await reason.inputValue(), 'Relevant work');
  assert.deepEqual(writes[0].answers.map(answer => [answer.prompt, answer.answer]), [['What is your notice period?', 'Two weeks'], ['Why do you want this role?', 'Relevant work']], 'identical short labels keep their own draft and answer context');
  mode = 'malformed';
  await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/answers'), page.getByRole('button', { name: 'Save answers', exact: true }).click()]);
  await page.locator('.answer-actions button:not([disabled])').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-saved'), '0');
  assert.equal(await notice.inputValue(), 'Two weeks', 'a malformed success never discards a draft');
  mode = 'held';
  const held = new Promise<void>(done => { holdStarted = done; });
  await page.getByRole('button', { name: 'Save answers', exact: true }).click();
  await held;
  await page.waitForFunction(() => document.querySelector('.answer-actions button')?.textContent === 'Saving…');
  await notice.fill('One month');
  assert.ok(release); release();
  await page.waitForFunction(() => document.documentElement.dataset.saved === '1');
  assert.equal(await notice.inputValue(), 'One month', 'an edit during the request remains unsaved and visible');
  assert.equal(await reason.inputValue(), '', 'the successfully submitted, unchanged draft is cleared');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('attention-fixture', { detail: JSON.stringify({ error: 'Could not check your jobs. Please try again.' }) })));
  await page.getByRole('alert').waitFor();
  assert.equal(await notice.inputValue(), 'One month', 'a background refresh error cannot unmount unsaved answers');
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('attention-fixture', { detail: JSON.stringify({ error: null, items: [{ jobId: 'fixture-job', title: 'Fixture role', company: 'Fixture employer', kind: 'question', reason: '', url: 'https://example.test', at: '2026-10-30T00:00:00Z', questions: [{ question: 'Tell us more', prompt: 'Which clearance do you hold?', options: ['None', 'Baseline'] }] }] }) }));
  });
  const choices = page.getByRole('combobox', { name: 'Which clearance do you hold?' });
  assert.equal(await choices.inputValue(), '', 'a new question with an old caption cannot inherit its answer');
  await page.getByRole('button', { name: 'Enter a different answer: Tell us more' }).click();
  await page.getByRole('textbox', { name: 'Which clearance do you hold?' }).fill('Secret');
  await page.getByRole('button', { name: 'Use captured choices: Tell us more' }).click();
  assert.equal(await choices.inputValue(), 'Secret', 'switching controls keeps a custom answer visibly selected');
  await page.getByRole('button', { name: 'Enter a different answer: Tell us more' }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Which clearance do you hold?' }).inputValue(), 'Secret');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('attention-fixture', { detail: JSON.stringify({ items: [{ jobId: 'fixture-job', title: 'Fixture role', company: 'Fixture employer', kind: 'question', reason: '', url: 'https://example.test', at: '2026-10-30T00:00:00Z', questions: [{ question: 'Tell us more *', prompt: 'Which clearance do you hold? *', options: ['None', 'Baseline'] }] }] }) })));
  assert.equal(await page.getByRole('textbox', { name: 'Which clearance do you hold? *', exact: true }).inputValue(), 'Secret', 'a marker-only background restatement cannot hide a draft');
  console.log('PASS: repeated captions, save failures, malformed success, in-flight edits, refresh errors and control switching retain correct candidate drafts. Fixture only.');
} finally {
  await browser?.close();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
