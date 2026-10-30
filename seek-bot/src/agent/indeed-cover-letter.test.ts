import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'patchright';
import { addIndeedCoverLetter } from './indeed-cover-letter.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadinessFixtureReply } from './readiness-fixture.js';

test('Indeed shortcut saves exact text; unfamiliar and partial flows stay recoverable without sending', { timeout: 25_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage();
  const letter = 'Dear Hiring Team,\n\nI offer relevant experience.\n\nKind regards,\nFixture Candidate';
  const fixture = (save = true, reject = false) => `<form onsubmit="event.preventDefault();window.sent=true">
    <section><h2>Resume</h2><button type="button" onclick="window.wrong=true">Add</button></section>
    <section><h2>Supporting documents</h2><button type="button" onclick="document.querySelector('#options').hidden=false">Add</button>
      <div id="options" hidden><button type="button" onclick="document.querySelector('#editor').hidden=false;this.hidden=true">Write a cover letter</button></div>
      <div id="editor" role="dialog" hidden><label>Cover letter<textarea oninput="${reject ? "this.value='rejected'" : ''}"></textarea></label>
      ${save ? '<button type="button" onclick="document.querySelector(\'#saved\').textContent=document.querySelector(\'textarea\').value;document.querySelector(\'#editor\').hidden=true">Save</button>' : ''}</div>
      <p id="saved" style="white-space:pre-wrap"></p></section><button>Submit application</button></form>`;
  try {
    await page.setContent(fixture());
    const saved = await addIndeedCoverLetter(page, letter);
    assert.equal(saved.status, 'saved', JSON.stringify(saved));
    assert.equal(saved.readback, letter);
    assert.equal(await page.evaluate(() => (window as any).sent || (window as any).wrong || false), false);
    await page.setContent(fixture(false));
    const partial = await addIndeedCoverLetter(page, letter);
    assert.equal(partial.status, 'fallback');
    assert.equal(partial.stage, 'save letter');
    assert.equal(await page.getByRole('textbox').inputValue(), letter, 'partial work remains for Magnus');
    await page.getByRole('dialog').evaluate(node => {
      const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Keep letter';
      save.onclick = () => { document.querySelector('#saved')!.textContent = (document.querySelector('textarea') as HTMLTextAreaElement).value; (node as HTMLElement).hidden = true; };
      node.append(save);
    });
    // Normal model-selected tools remain usable after shortcut failure.
    await page.getByRole('button', { name: 'Keep letter' }).click();
    assert.equal(await page.locator('#saved').innerText(), letter);
    await page.setContent(fixture(true, true));
    assert.equal((await addIndeedCoverLetter(page, letter)).status, 'fallback', 'React-like rejected changes cannot report saved');
    await page.setContent('<main><h1>No document section</h1><button type="button" onclick="window.wrong=true">Add</button><button onclick="window.sent=true">Submit application</button></main>');
    const absent = await addIndeedCoverLetter(page, letter);
    assert.equal(absent.status, 'fallback');
    assert.deepEqual(absent.completed, []);
    assert.equal(await page.evaluate(() => (window as any).sent || (window as any).wrong || false), false);
  } finally { await browser.close(); }
});

test('applying agent retains all browser tools after a partial shortcut and completes the fixture', { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owtomate-letter-fallback-'));
  const keys = ['DATA_DIR', 'CELERIS_API_KEY', 'COST_TRACKING', 'FORM_CORPUS_DIR', 'APPLICATION_REVIEW_MODE'];
  const previous = keys.map(key => process.env[key]);
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, { DATA_DIR: dir, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false', FORM_CORPUS_DIR: join(dir, 'corpus'), APPLICATION_REVIEW_MODE: '' });
  const { config } = await import('../config.js');
  const before = { dryRun: config.dryRun, allowExternalApply: config.allowExternalApply };
  config.dryRun = true; config.allowExternalApply = true;
  const { runAgentOnlyApplication } = await import('./agent-only.js');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<main><div role="dialog"><label>Cover letter<textarea></textarea></label><button type="button" id="keep" onclick="document.querySelector('#saved').textContent=document.querySelector('textarea').value;document.querySelector('[role=dialog]').hidden=true">Keep this text</button></div><p id="saved" style="white-space:pre-wrap"></p><button type="button" id="send" onclick="document.querySelector('main').textContent='Application received: LETTER-FIXTURE'">Send application</button></main>` }));
    const job = { id: 'letter-fallback-fixture', title: 'Fictional developer', company: 'Fixture', location: 'Exampletown', platform: 'indeed' as const, url: 'https://form.fixture.invalid/apply' };
    await page.goto(job.url);
    const letter = 'Dear Team,\n\nMy relevant experience.\n\nFixture Candidate';
    const calls = [
      { name: 'add_cover_letter', args: { text: letter } },
      { name: 'browser_action', args: { action: 'click', selector: '#keep' } },
      { name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } },
      { name: 'finish', args: { status: 'applied', reason: 'Fixture receipt', evidence: 'Application received: LETTER-FIXTURE', receipt: { quote: 'Application received: LETTER-FIXTURE' } } },
    ];
    let sequence = 0;
    const readiness = createReadinessFixtureReply();
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const review = readiness(body); if (review) return review;
      const call = calls.shift(); assert.ok(call, 'no unexpected model calls or forced recovery loops');
      assert.ok(body.tools.some((tool: any) => tool.function.name === call.name), `${call.name} remains available`);
      if (call.name === 'browser_action' && call.args.selector === '#keep') assert.equal(await page.getByRole('textbox').inputValue(), letter);
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `letter-${++sequence}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
    }) as typeof fetch;
    const result = await runAgentOnlyApplication({ page, job, profile: { name: 'Fixture Candidate', email: '', phone: '', skills: [] } as never, log: () => {}, simulation: 'isolated-form' });
    assert.equal(result.outcome.status, 'rehearsed');
    assert.match(result.outcome.status === 'rehearsed' ? result.outcome.stoppedAt : '', /applied/);
    assert.equal(result.coverLetter, letter);
    assert.equal(calls.length, 0);
    assert.match(await page.locator('main').innerText(), /Application received: LETTER-FIXTURE/);
  } finally {
    globalThis.fetch = previousFetch;
    Object.assign(config, before);
    await browser.close();
    keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    rmSync(dir, { recursive: true, force: true });
  }
});
