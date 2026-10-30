import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { createReadinessFixtureReply } from './readiness-fixture.js';

test('captured autocomplete values survive wizard preparation and exact approved reconstruction', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owtomate-prepared-values-'));
  const previousFetch = globalThis.fetch;
  const keys = ['DATA_DIR', 'CELERIS_API_KEY', 'COST_TRACKING', 'FORM_CORPUS_DIR', 'APPLICATION_REVIEW_MODE', 'RESUME_SELECT'];
  const previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { DATA_DIR: dir, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false',
    FORM_CORPUS_DIR: join(dir, 'corpus'), APPLICATION_REVIEW_MODE: 'prepare', RESUME_SELECT: '' });
  const { runAgentOnlyApplication } = await import('./agent-only.js');
  const { config } = await import('../config.js');
  config.dryRun = false; config.allowExternalApply = true;
  mkdirSync(join(dir, 'resumes'));
  writeFileSync(join(dir, 'resumes', 'CV.txt'), 'Fictional candidate in Exampletown.');
  writeFileSync(join(dir, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fixture CV', fileName: 'CV.txt' }]));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage();
    let selected = 'Exampletown, State, Country';
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<main>
      <section id="entry"><label for="city">City *</label><input id="city" role="combobox" oninput="document.querySelector('#option').hidden=false">
      <button id="option" type="button" role="option" hidden onclick="document.querySelector('#city').value='${selected}';this.hidden=true">${selected}</button>
      <button id="next" type="button" onclick="document.querySelector('#saved').textContent=document.querySelector('#city').value;document.querySelector('#entry').hidden=true;document.querySelector('#review').hidden=false">Next</button></section>
      <section id="review" hidden><p id="saved"></p><button id="send" type="button" onclick="document.querySelector('main').textContent='Application received: VALUE-FIXTURE'">Send application</button></section></main>` }));
    const job = { id: 'value-fixture', title: 'Fictional developer', company: 'Fixture', location: 'Exampletown', platform: 'seek' as const, url: 'https://form.fixture.invalid/apply' };
    const profile = { name: 'Fixture Candidate', suburb: 'Exampletown', email: '', phone: '', skills: [] } as never;
    const navigation = () => [
      { name: 'browser_action', args: { action: 'fill', selector: '#city', value: 'Exampletown' } },
      { name: 'browser_action', args: { action: 'click', selector: '#option' } },
      { name: 'browser_action', args: { action: 'click', selector: '#next' } },
      { name: 'prepare_application', args: { submit_selector: '#send', answers: [], resume_id: 'cv' } },
    ];
    let calls: any[] = [], sequence = 0;
    const model = () => {
      const readiness = createReadinessFixtureReply();
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const review = readiness(body); if (review) return review;
        const call = calls.shift(); assert.ok(call, 'no unexpected decision');
        return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `value-${++sequence}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
      }) as typeof fetch;
    };
    await page.goto(job.url); calls = navigation(); model();
    const prepared = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
    assert.equal(prepared.outcome.status, 'prepared');
    assert.ok(prepared.outcome.status === 'prepared');
    const draft = prepared.outcome.draft;
    assert.equal(draft.answers.find(answer => answer.question === 'City *')?.answer, 'Exampletown, State, Country');
    writeFileSync(join(dir, 'approved-applications.json'), JSON.stringify([draft]));
    process.env.APPLICATION_REVIEW_MODE = 'approved';
    await page.goto(job.url);
    calls = [...navigation(),
      { name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } },
      { name: 'finish', args: { status: 'applied', reason: 'Fictional receipt observed', evidence: 'Application received: VALUE-FIXTURE', receipt: { quote: 'Application received: VALUE-FIXTURE' } } }];
    model();
    const submitted = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
    assert.equal(submitted.outcome.status, 'applied', 'the same saved value must not create a different draft on reconstruction');
    selected = 'Different town, State, Country';
    await page.goto(job.url); calls = navigation(); model();
    const changed = await runAgentOnlyApplication({ page, job, profile, log: () => {} });
    assert.equal(changed.outcome.status, 'prepared', 'an actual change still requires candidate confirmation');
    assert.ok(changed.outcome.status === 'prepared');
    assert.equal(changed.outcome.draft.answers.find(answer => answer.question === 'City *')?.answer, selected);
  } finally {
    globalThis.fetch = previousFetch;
    await browser.close();
    keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    rmSync(dir, { recursive: true, force: true });
  }
});
