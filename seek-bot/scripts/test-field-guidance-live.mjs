// Actual MiniMax, native production tools, fictional evidence and isolated pages.
// Build first. This intentionally spends API credits only with --live.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';

if (!process.argv.includes('--live')) throw Error('Pass --live to test real MiniMax on fictional forms.');
const directory = mkdtempSync(join(tmpdir(), 'owtomate-field-guidance-live-'));
Object.assign(process.env, {
  APPLICATION_AI_MODEL: 'minimax', DATA_DIR: directory, DRY_RUN: 'true', COST_TRACKING: 'false',
  ALLOW_EXTERNAL_APPLY: 'true', APPLICATION_REVIEW_MODE: '', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false',
  RESUME_SELECT: 'fixture-cv', FORM_CORPUS_DIR: join(directory, 'corpus'), KEYWORDS: 'data analyst', TARGET_ROLE: '',
  COVER_LETTER_MODE: 'tailored', COVER_LETTER_TEXT_B64: '', COVER_LETTER_INSTRUCTIONS: '', AI_INSTRUCTIONS_B64: '',
  AGENT_BUDGET_USD: '0.20', AGENT_PROGRESS_BUDGET_USD: '0.40',
});
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), 'Alex Fixture. Data Analyst at Fixture Analytics from February 2024 to October 2026. SQL, Python and Power BI reporting. Lives in Sydney, Australia. Australian citizen. Email alex@example.invalid. Phone 0400000000.');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'fixture-cv', label: 'Fixture CV', fileName: 'Fixture CV.txt', isDefault: true }]));
const { config } = await import('../dist/config.js');
const { runApplicationAgent } = await import('../dist/agent/loop.js');
const { applicationAgentIdentity } = await import('../dist/application-model.js');
assert.equal(applicationAgentIdentity().selection, 'minimax');
if (!process.env.OPENROUTER_API_KEY) throw Error('OPENROUTER_API_KEY is not configured.');
assert.equal(config.dryRun, true);

const html = autocomplete => `<!doctype html><style>body{font:18px Arial;margin:30px;max-width:1000px}label{display:block;margin:15px 0}input,select,textarea,button{font:inherit;padding:8px}textarea{width:90%;height:100px}[role=alert]{color:#a00}</style>
<main><h1>Data Analyst application</h1><p>Fictional Employer, Sydney. Isolated form test.</p>
<label>Full name<input id=name required></label><label>Email<input id=email type=email required></label>
<label>City<input id=city required ${autocomplete ? 'aria-autocomplete=list aria-controls=cities oninput="this.dataset.committed=\'false\';document.querySelector(\'#cities\').hidden=!this.value.toLowerCase().startsWith(\'syd\')"' : ''}></label>
${autocomplete ? '<div id=cities role=listbox hidden><button type=button role=option onclick="document.querySelector(\'#city\').value=\'Sydney\';document.querySelector(\'#city\').dataset.committed=\'true\';this.parentElement.hidden=true">Sydney, Australia</button></div><p>Choose the suggested city after typing.</p>' : ''}
<label>Country<select id=country required><option value="">Choose</option><option value=au>Australia</option><option value=nz>New Zealand</option></select></label>
<h2>Work experience</h2><p id=error role=alert>Finish or remove the incomplete work experience entry before submitting.</p>
<section id=experience><label>Employer<input id=employer value="Fixture Analytics" required></label><label>Job title<input id=title required></label><label>Start date<input id=start type=month required></label><label>End date<input id=end type=month required></label>
<button type=button id=save onclick="const ids=['employer','title','start','end'];if(!ids.every(id=>document.getElementById(id).reportValidity()))return;window.historyEntry=Object.fromEntries(ids.map(id=>[id,document.getElementById(id).value]));window.historySaves=(window.historySaves||0)+1;document.querySelector('#summary').textContent=Object.values(window.historyEntry).join(' · ');this.parentElement.hidden=true;document.querySelector('#error').textContent=''">Save experience</button>
<button type=button id=remove onclick="this.parentElement.hidden=true;window.historyEntry=null;document.querySelector('#summary').textContent='No saved experience';document.querySelector('#add').hidden=false;document.querySelector('#error').textContent='At least one saved experience is required'">Remove incomplete experience</button></section>
<p id=summary></p><button type=button id=add hidden onclick="document.querySelector('#experience').hidden=false;this.hidden=true">Add experience</button>
<label>Resume<input id=cv type=file accept=.txt required></label><label>Cover letter<textarea id=letter required></textarea></label>
<label><input id=consent type=checkbox required>I accept the fictional application terms and privacy notice</label>
<button type=button id=send onclick="window.submitAttempts=(window.submitAttempts||0)+1;const required=['name','email','city','country','cv','letter','consent'];if(!required.every(id=>document.getElementById(id).reportValidity()))return;if(!window.historyEntry){document.querySelector('#error').textContent='Please save at least one work experience entry';return}${autocomplete ? 'if(document.querySelector(\'#city\').dataset.committed!==\'true\'){document.querySelector(\'#error\').textContent=\'Select a suggested city\';return}' : ''};window.submissions=(window.submissions||0)+1;window.receipt={name:document.querySelector('#name').value,email:document.querySelector('#email').value,city:document.querySelector('#city').value,country:document.querySelector('#country').value,cv:document.querySelector('#cv').files[0].name,letter:document.querySelector('#letter').value,consent:document.querySelector('#consent').checked,history:window.historyEntry};document.querySelector('main').innerHTML='<h1>Application submitted successfully</h1><p>Receipt FIELD-GUIDANCE-${autocomplete ? 'autocomplete' : 'native'}</p>'">Submit application</button></main>`;

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch;
const results = [];
let blockedRealRequests = 0;
try {
  for (const autocomplete of [false, true]) {
    const fixture = autocomplete ? 'autocomplete' : 'native';
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).hostname !== 'field-guidance.fixture.invalid') { blockedRealRequests++; return route.abort(); }
      return route.fulfill({ contentType: 'text/html', body: html(autocomplete) });
    });
    const page = await context.newPage();
    const url = `https://field-guidance.fixture.invalid/apply/${fixture}`;
    await page.goto(url);
    const calls = [];
    globalThis.fetch = async (input, init) => {
      // Permit only the configured model provider, not employer/email traffic.
      assert.equal(new URL(String(input)).hostname, 'openrouter.ai');
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools?.length) {
        assert.equal(body.model, applicationAgentIdentity().model);
        assert.equal(body.reasoning?.effort, 'high', 'Every form decision must use high reasoning');
        calls.push({ reasoning: body.reasoning.effort });
      }
      return originalFetch(input, init);
    };
    const logs = [];
    const started = Date.now();
    try {
      const result = await runApplicationAgent({ page, simulation: 'isolated-form',
        job: { id: `field-guidance-${fixture}`, title: 'Data Analyst', company: 'Fictional Employer', location: 'Sydney', url,
          platform: 'smartrecruiters', source: 'chosen', applicationMode: 'external', description: 'Data Analyst using SQL, Python and Power BI. Include the selected CV and a tailored cover letter.' },
        profile: { name: 'Alex Fixture', email: 'alex@example.invalid', phone: '0400000000', nationality: 'Australian', workRights: 'Citizen', workRightsCountry: 'Australia',
          expectedSalary: 'AUD 135000', noticePeriod: 'Two weeks', willingToRelocate: false, skills: ['SQL', 'Python', 'Power BI'],
          experienceSummary: 'Data Analyst at Fixture Analytics from February 2024 to October 2026. Lives in Sydney, Australia. Australian citizen.', excludedDomains: [], securityClearance: 'None held' },
        log: line => { logs.push(line); if (/failed|budget|invalid/i.test(line)) console.log(`[${fixture}] ${line}`); } });
      const actual = await page.evaluate(() => ({ submissions: window.submissions || 0, submitAttempts: window.submitAttempts || 0, historySaves: window.historySaves || 0, receipt: window.receipt }), undefined, undefined, false);
      assert.equal(actual.submissions, 1, `No validated local receipt: ${JSON.stringify(result.outcome)}`);
      assert.equal(actual.receipt.name, 'Alex Fixture');
      assert.equal(actual.receipt.email, 'alex@example.invalid');
      assert.equal(actual.receipt.city, 'Sydney');
      assert.equal(actual.receipt.country, 'au');
      assert.match(actual.receipt.cv, /Fixture CV\.txt/);
      assert.ok(actual.receipt.letter.trim().length > 80);
      assert.equal(actual.receipt.consent, true);
      assert.deepEqual(actual.receipt.history, { employer: 'Fixture Analytics', title: 'Data Analyst', start: '2024-02', end: '2026-10' });
      assert.ok(actual.historySaves >= 1);
      assert.equal(result.outcome.status, 'rehearsed');
      assert.match(await page.locator('main').innerText(), /Application submitted successfully/);
      assert.ok(calls.length);
      results.push({ fixture, passed: true, model: applicationAgentIdentity().model, reasoning: 'high', steps: result.steps, requests: calls.length,
        usage: result.usage, elapsedMs: Date.now() - started, submissions: actual.submissions, historySaves: actual.historySaves, submitAttempts: actual.submitAttempts });
    } catch (error) {
      results.push({ fixture, passed: false, error: error.message, requests: calls.length, elapsedMs: Date.now() - started,
        pageText: await page.locator('body').innerText().catch(() => ''), logs });
      process.exitCode = 1;
    } finally { await context.close(); }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  mkdirSync(new URL('../output/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../output/field-guidance-live.json', import.meta.url), JSON.stringify({ realEmployerSubmissions: 0, blockedRealRequests, results }, null, 2));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-field-guidance-live-'));
  rmSync(directory, { recursive: true, force: true });
}
