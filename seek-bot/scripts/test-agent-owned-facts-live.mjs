// Real Magnus with fictional, network-isolated forms. No employer submissions.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

if (!process.argv.includes('--live')) throw new Error('Pass --live to use the configured Magnus API with fictional applications.');
const dir = mkdtempSync(join(tmpdir(), 'agent-owned-facts-'));
Object.assign(process.env, { DATA_DIR: dir, DRY_RUN: 'false', COST_TRACKING: 'false', ALLOW_EXTERNAL_APPLY: 'true',
  APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'true', APPLICATION_REVIEW_MODE: '', RESUME_SELECT: 'cv',
  FORM_CORPUS_DIR: join(dir, 'corpus'), KEYWORDS: 'software developer', TARGET_ROLE: '',
  COVER_LETTER_MODE: 'tailored', COVER_LETTER_TEXT_B64: '', COVER_LETTER_INSTRUCTIONS: '', AI_INSTRUCTIONS_B64: '',
  AGENT_BUDGET_USD: '0.20', AGENT_PROGRESS_BUDGET_USD: '0.20' });
mkdirSync(join(dir, 'resumes'));
writeFileSync(join(dir, 'resumes/CV.txt'), 'Alex Fixture. Freelance Software Developer. Two years of TypeScript and React development. Based in Sydney.');
writeFileSync(join(dir, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fictional CV', fileName: 'CV.txt' }]));
const { config } = await import('../dist/config.js');
const { runApplicationAgent } = await import('../dist/agent/loop.js');
if (!config.celeris.apiKey) throw new Error('CELERIS_API_KEY is not configured.');
const profile = { name: 'Alex Fixture', email: 'alex@example.invalid', phone: '', nationality: '', workRights: '',
  expectedSalary: '', noticePeriod: '', willingToRelocate: false, skills: ['TypeScript', 'React'],
  experienceSummary: 'Freelance Software Developer, two years of TypeScript and React development.', excludedDomains: [], securityClearance: '' };
const cases = [
  { id: 'auto-missing-date', mode: '', known: false, expected: 'needs-human' },
  { id: 'auto-correct-date', mode: '', known: true, expected: 'applied' },
  { id: 'semi-missing-date', mode: 'prepare', known: false, expected: 'needs-human' },
  { id: 'semi-correct-date', mode: 'prepare', known: true, expected: 'prepared' },
  { id: 'optional-unknown', mode: '', known: false, optional: true, expected: 'applied' },
];
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch;
const results = [];
try {
  for (const fixture of cases) {
    process.env.APPLICATION_REVIEW_MODE = fixture.mode;
    writeFileSync(join(dir, 'answers.json'), JSON.stringify(fixture.known
      ? [{ question: 'Freelance Software Developer start month and year', answer: 'February 2024', createdAt: '2026-10-27T00:00:00Z' }] : []));
    const context = await browser.newContext();
    await context.route('**/*', route => {
      if (!new URL(route.request().url()).hostname.endsWith('.invalid')) return route.abort();
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><main><h1>Software Developer application</h1><p>Fictional Employer, Sydney. Isolated fixture.</p>
        <form onsubmit="event.preventDefault();window.sends=(window.sends||0)+1;window.sentValue=document.querySelector('#fact').value;document.querySelector('main').innerHTML='<h1>Your application has been received.</h1><p>Receipt ${fixture.id}</p>'">
        ${fixture.optional ? '<label>Previously employed by Fictional Employer? (optional)<select id=fact><option value="">Choose</option><option>Yes</option><option>No</option><option>Prefer not to say</option></select></label>'
          : `<label>Freelance Software Developer start month and year<input id=fact type=month required value="${fixture.known ? '2022-03' : ''}"></label>`}
        <label>Cover letter<textarea id=letter></textarea></label><label>CV<input type=file></label><button id=send>Submit application</button></form></main>` });
    });
    const page = await context.newPage();
    const url = `https://facts.fixture.invalid/apply/${fixture.id}`;
    await page.goto(url);
    let agentRequests = 0, classificationRequests = 0;
    globalThis.fetch = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.tools?.length) agentRequests++;
      else {
        assert.match(JSON.stringify(body.messages), /Would pressing the control/, 'No separate fact reviewer may run.');
        classificationRequests++;
      }
      return originalFetch(input, init);
    };
    const started = Date.now();
    try {
      const run = await runApplicationAgent({ page, profile,
        job: { id: fixture.id, title: 'Software Developer', company: 'Fictional Employer', location: 'Sydney', platform: 'seek',
          url, source: 'chosen', applicationMode: 'external', description: 'Fictional TypeScript/React software development role. Candidate history must come from saved candidate evidence.' }, log: () => {} });
      const actual = await page.evaluate(() => ({ sends: window.sends || 0, value: window.sentValue ?? document.querySelector('#fact')?.value }), undefined, undefined, false);
      assert.equal(run.outcome.status, fixture.expected, JSON.stringify(run.outcome));
      assert.equal(actual.sends, fixture.expected === 'applied' ? 1 : 0);
      if (fixture.known && !fixture.mode) assert.equal(actual.value, '2024-02', 'The agent must correct the conflicting prefilled date.');
      if (fixture.optional) assert.ok(['', 'Prefer not to say'].includes(actual.value), 'An optional unknown must not become a false Yes/No.');
      if (fixture.expected === 'needs-human') assert.ok(run.outcome.questions?.length);
      results.push({ fixture: fixture.id, passed: true, status: run.outcome.status, turns: run.steps, usage: run.usage,
        elapsedMs: Date.now() - started, agentRequests, classificationRequests, ...actual });
    } catch (error) {
      results.push({ fixture: fixture.id, passed: false, error: error.message, elapsedMs: Date.now() - started });
      process.exitCode = 1;
    } finally { await context.close(); }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  mkdirSync(new URL('../output/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../output/agent-owned-facts-live.json', import.meta.url), JSON.stringify({ realEmployerSubmissions: 0, results }, null, 2));
  rmSync(dir, { recursive: true, force: true });
}
