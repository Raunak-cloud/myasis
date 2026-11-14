// A/B runner: identical fictional forms, real configured model, no employers.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'patchright';

if (!process.argv.includes('--live')) throw Error('Pass --live to test the configured model on fictional forms.');
const option = name => process.argv.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
const release = resolve(option('--release-root') ?? process.cwd());
const output = resolve(option('--out') ?? 'browser-tools-live-results.json');
const onlyCase = option('--case');
const directory = mkdtempSync(join(tmpdir(), 'owtomate-browser-tools-live-'));
Object.assign(process.env, { DATA_DIR: directory, APPLICATION_AI_MODEL: 'minimax', DRY_RUN: 'false', COST_TRACKING: 'false',
  ALLOW_EXTERNAL_APPLY: 'true', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false', FORM_CORPUS_DIR: join(directory, 'corpus'),
  CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'), CELERIS_MIN_INTERVAL_MS: '0', RESUME_SELECT: 'cv',
  AGENT_BUDGET_USD: '0.15', AGENT_PROGRESS_BUDGET_USD: '0.15', COVER_LETTER_INSTRUCTIONS: 'Keep the letter short and direct.',
  AI_INSTRUCTIONS_B64: '', COVER_LETTER_MODE: 'tailored', COVER_LETTER_TEXT_B64: '', KEYWORDS: 'business analyst', TARGET_ROLE: 'Business Analyst',
  SEARCH_LOCATION: 'Sydney', ONSITE_CITY: 'Sydney', WORK_ARRANGEMENTS: 'onsite,hybrid', EXCLUDED_COMPANIES: '', EXCLUDED_DOMAINS: '',
  PROFILE_PATH: join(directory, 'profile.txt'), GMAIL_MCP_URL: '', GMAIL_MCP_TOKEN: '', GMAIL_MCP_ACCOUNT: '' });
writeFileSync(join(directory, 'profile.txt'), 'Name: Alex Fixture\nEmail: alex@fixture.invalid\nSkills: SQL, Power BI\n');
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes/CV.txt'), 'Alex Fixture. Sydney, Australia. Business Analyst with three years of SQL, Power BI and reporting experience. alex@fixture.invalid.');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fixture CV', fileName: 'CV.txt' }]));
const { runAgentOnlyApplication, agentOnlyTools } = await import(pathToFileURL(join(release, 'dist/agent/agent-only.js')).href);
const { closeCelerisQueues } = await import(pathToFileURL(join(release, '../shared/celeris-queue.mjs')).href);
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch, results = [];
try {
  for (const [id, semi, chooser] of [['basic-auto', false, false], ['chooser-auto', false, true], ['basic-semi', true, false]].filter(([id]) => !onlyCase || id === onlyCase)) {
    process.env.APPLICATION_REVIEW_MODE = semi ? 'prepare' : '';
    const context = await browser.newContext(), url = `https://browser-tools.fixture.invalid/${id}`, receipt = `Application received for Alex Fixture, Business Analyst at Fictional Employer. Receipt ${id}.`;
    let sends = 0, inputTokens = 0, outputTokens = 0, cachedTokens = 0, calls = 0, providerCostUsd = 0, costReported = false;
    const form = `<main><h1>Business Analyst at Fictional Employer, Sydney</h1><p>SQL, Power BI and reporting. Open vacancy.</p><form onsubmit="event.preventDefault();localStorage.setItem('fixture-record',JSON.stringify({name:document.querySelector('#name').value,email:document.querySelector('#email').value,letter:document.querySelector('#letter').value,file:document.querySelector('#cv').files[0].name}));localStorage.setItem('fixture-sends',String(Number(localStorage.getItem('fixture-sends')||0)+1));document.querySelector('main').innerHTML='<h1>${receipt}</h1>'"><label>Full name<input id=name required></label><label>Email<input id=email type=email required></label><label>Cover letter<textarea id=letter></textarea></label><label>CV<input id=cv type=file required ${chooser ? 'hidden' : ''}></label>${chooser ? '<button type=button id=upload onclick="document.querySelector(\'#cv\').click()">Upload CV</button>' : ''}<label><input type=checkbox required>I accept the application terms</label><button id=send>Submit application</button></form></main>`;
    await context.route('**/*', route => {
      if (!new URL(route.request().url()).hostname.endsWith('.invalid')) return route.abort();
      return route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname.endsWith('/apply') ? form
        : `<main><h1>Business Analyst at Fictional Employer</h1><p>Sydney. SQL, Power BI and reporting. Applications open.</p><a href="${url}/apply">Apply now</a></main>` });
    });
    const page = await context.newPage(); await page.goto(url);
    globalThis.fetch = async (...args) => {
      const address = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0].url;
      if (new URL(address).hostname !== 'openrouter.ai') throw Error('The fixture allows model requests only; other host services are unavailable.');
      const response = await originalFetch(...args);
      let request; try { request = JSON.parse(String(args[1]?.body)); } catch {}
      if (request?.tools?.length) {
        assert.equal(request.reasoning?.effort, 'high'); calls++;
        const data = await response.clone().json().catch(() => ({})), usage = data.usage ?? {};
        inputTokens += usage.prompt_tokens ?? 0; outputTokens += usage.completion_tokens ?? 0;
        cachedTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
        if (typeof usage.cost === 'number') { providerCostUsd += usage.cost; costReported = true; }
      }
      return response;
    };
    const start = Date.now();
    const result = await runAgentOnlyApplication({ page,
      job: { id, title: 'Business Analyst', company: 'Fictional Employer', location: 'Sydney', url, source: 'chosen', platform: 'indeed', description: 'Business analysis, SQL, Power BI and reporting.' },
      profile: { name: 'Alex Fixture', email: 'alex@fixture.invalid', suburb: 'Sydney', experienceSummary: 'Three years of business analysis, SQL, Power BI and reporting.', skills: ['SQL', 'Power BI'] }, log: () => {} });
    const elapsedMs = Date.now() - start;
    sends = await page.evaluate(() => Number(localStorage.getItem('fixture-sends') || 0));
    const saved = await page.evaluate(() => {
      const received = localStorage.getItem('fixture-record');
      if (received) return JSON.parse(received);
      return { name: document.querySelector('#name')?.value, email: document.querySelector('#email')?.value,
        letter: document.querySelector('#letter')?.value, file: document.querySelector('#cv')?.files[0]?.name };
    });
    const trace = JSON.parse(readFileSync(join(directory, 'traces', `${id}.json`), 'utf8'));
    const errors = trace.steps.filter(step => ['failed', 'invalid-arguments'].includes(step.disposition));
    const tools = Object.fromEntries([...new Set(trace.steps.map(step => step.tool))].map(tool => [tool, trace.steps.filter(step => step.tool === tool).length]));
    const checks = { name: saved.name === 'Alex Fixture', email: saved.email === 'alex@fixture.invalid', letter: Boolean(saved.letter?.trim()), resume: saved.file === 'CV.txt' };
    const answersCorrect = Object.values(checks).every(Boolean);
    const row = { id, outcome: result.outcome.status, expected: semi ? 'prepared' : 'applied', sends, answersCorrect, checks, selectedFile: saved.file, elapsedMs,
      modelCalls: calls, inputTokens, outputTokens, cachedTokens, providerCostUsd: costReported ? providerCostUsd : null, usage: result.usage,
      toolErrors: errors.length, errorKinds: errors.map(step => ({ tool: step.tool, disposition: step.disposition, result: String(step.result).slice(0, 250) })), tools };
    results.push(row); writeFileSync(output, JSON.stringify({ release, schemaBytes: Buffer.byteLength(JSON.stringify(agentOnlyTools)), results }, null, 2));
    console.log(JSON.stringify(row));
    if (!semi && sends) assert.ok(await page.locator('body').innerText().then(text => text.includes(receipt)));
    await context.close();
  }
  assert.ok(results.length && results.every(row => row.outcome === row.expected && row.answersCorrect && row.sends === (row.expected === 'prepared' ? 0 : 1)), 'Some fictional forms did not complete correctly; inspect the recorded results.');
} finally {
  globalThis.fetch = originalFetch; await browser.close(); closeCelerisQueues();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-browser-tools-live-')); rmSync(directory, { recursive: true, force: true });
}
