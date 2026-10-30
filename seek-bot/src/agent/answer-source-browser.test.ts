import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { JobListing } from '../types.js';

const directory = mkdtempSync(join(tmpdir(), 'answer-source-browser-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', APPLICATION_AI_MODEL: 'celeris', DRY_RUN: 'false',
  ALLOW_EXTERNAL_APPLY: 'true', AGENT_BUDGET_USD: '0.20', APPLICATION_REVIEW_MODE: '', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false', FORM_CORPUS_DIR: join(directory, 'corpus') });
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Fictional candidate');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', fileName: 'CV.txt', label: 'CV' }]));
writeFileSync(join(directory, 'answers.json'), '[]');
let turn = 0;
globalThis.fetch = (async () => {
  const call = turn++ === 0 ? { name: 'browser_batch', args: { actions: [
    { action: 'fill', selector: '#candidateYear', value: '2011' },
    { action: 'fill', selector: '#city', value: 'Sydney' },
    { action: 'click', selector: '#commit' },
    { action: 'click', selector: '#navigate' },
  ] } } : { name: 'finish', args: { status: 'skipped', reason: 'Offline source attribution checked', evidence: 'Committed candidate year and city retained independently of the navigation control' } };
  return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `source-${turn}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }], usage: { prompt_tokens: 30, completion_tokens: 10 } });
}) as typeof fetch;
const { runApplicationAgent } = await import('./loop.js');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  const url = 'https://employer.fixture.invalid/apply';
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<main>
    <section><label>Year<input id=candidateYear></label></section>
    <label>City<input id=city></label><button id=commit onclick="document.querySelector('#city').value='Sydney, Australia'">Commit city</button>
    <aside><label>Year<input id=navigationYear value=2026></label><button id=navigate onclick="document.querySelector('#navigationYear').value='2013'">Previous year</button></aside>
    </main>` }));
  await page.goto(url);
  const result = await runApplicationAgent({ page, job: { id: 'answer-source-fixture', title: 'Developer', company: 'Fixture', location: 'Sydney', url, applicationMode: 'external' } as JobListing,
    profile: { name: 'Alex Fixture', email: 'fixture@example.invalid', skills: ['TypeScript'], willingToRelocate: false } as never, log: () => {} });
  assert.equal(turn, 2);
  assert.equal(result.captured.find(answer => answer.question === 'Year')?.answer, '2011', 'an unrelated identically labelled control cannot overwrite the candidate answer');
  assert.equal(result.captured.find(answer => answer.question === 'City')?.answer, 'Sydney, Australia', 'the written control still records its later committed selection');
  assert.equal(await page.locator('#navigationYear').inputValue(), '2013', 'the agent can still operate navigation controls');
  console.log('PASS: native answer sources retain committed selections without same-label navigation overwrites.');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
