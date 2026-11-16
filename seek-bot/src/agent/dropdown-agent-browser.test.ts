import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { specialistFixtureReply } from './specialist-fixture.js';
import type { JobListing } from '../types.js';

const directory = mkdtempSync(join(tmpdir(), 'dropdown-agent-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', APPLICATION_AI_MODEL: 'celeris', DRY_RUN: 'false', ALLOW_EXTERNAL_APPLY: 'true', AGENT_BUDGET_USD: '0.20', FORM_CORPUS_DIR: join(directory, 'corpus'), APPLICATION_REVIEW_MODE: '', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false' });
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes.json'), '[]');
writeFileSync(join(directory, 'answers.json'), '[]');
let turn = 0;
globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const specialist = specialistFixtureReply(body); if (specialist) return specialist;
  const latest = body.messages.filter((message: { role: string }) => message.role === 'tool').at(-1)?.content;
  let call;
  if (turn === 0) call = { name: 'browser_batch', args: { actions: [{ action: 'fill', selector: '#institution', value: 'SHIATS' }, { action: 'fill', selector: '#other', value: 'Must not run' }] } };
  else if (turn === 1) {
    const result = JSON.parse(latest);
    assert.equal(result.remainingNotExecuted, true);
    assert.equal(JSON.parse(result.results[0].message).dropdown.status, 'no-results');
    call = { name: 'browser_fill', args: { selector: '#institution', value: 'SHIATS' } };
  } else if (turn === 2) {
    assert.equal(JSON.parse(latest).dropdown.status, 'repeat-blocked');
    call = { name: 'browser_fill', args: { selector: '#institution', value: 'Full Institution Name' } };
  } else if (turn === 3) {
    const feedback = JSON.parse(latest).dropdown;
    assert.equal(feedback.selected, true);
    assert.equal(feedback.clickedOption, 'Full Institution Name');
    call = { name: 'finish', args: { status: 'skipped', reason: 'Fictional dropdown recovery check complete.', evidence: 'A full-name query selected the matching institution.' } };
  } else throw Error('Unexpected agent turn');
  return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `dropdown-${turn++}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }], usage: { prompt_tokens: 30, completion_tokens: 10 } });
}) as typeof fetch;
const { runApplicationAgent } = await import('./loop.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid') ? route.fulfill({ contentType: 'text/html', body: '<main>Fixture</main>' }) : route.abort());
  const page = await context.newPage(), url = 'https://dropdown.fixture.invalid/apply';
  await page.goto(url);
  await page.setContent(`<main><label>Institution<input id="institution" role="combobox" aria-controls="choices" aria-expanded="false" aria-invalid="true" oninput="window.inputs=(window.inputs||0)+1;this.setAttribute('aria-expanded','true');choices.hidden=false;choices.innerHTML=this.value==='Full Institution Name'?'&lt;div role=option&gt;Full Institution Name&lt;/div&gt;':'&lt;p role=status&gt;No results found&lt;/p&gt;'"></label><div id="choices" role="listbox" hidden></div><label>Other<input id="other" value="Untouched"></label></main><script>choices.onclick=e=>{if(e.target.getAttribute('role')!=='option')return;institution.value=e.target.textContent;institution.setAttribute('aria-expanded','false');institution.setAttribute('aria-invalid','false');choices.hidden=true}</script>`);
  const result = await runApplicationAgent({ page, job: { id: 'dropdown-fixture', title: 'Fixture', company: 'Fictional employer', location: 'Sydney', url, applicationMode: 'external' } as JobListing, profile: { name: 'Alex Fixture', email: 'fixture@example.invalid', skills: ['Analytics'], willingToRelocate: false } as never, log: () => {} });
  assert.equal(result.outcome.status, 'skipped');
  assert.equal(turn, 4);
  assert.equal(await page.locator('#other').inputValue(), 'Untouched');
  assert.equal(await page.evaluate('window.inputs', undefined, undefined, false), 2, 'unchanged repeat never types again');
  assert.equal(await page.locator('#institution').inputValue(), 'Full Institution Name');
  console.log('PASS: real agent pauses the batch for no-results, blocks unchanged search, and selects an evidence-supported alternate query. No real applications or external requests.');
} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
