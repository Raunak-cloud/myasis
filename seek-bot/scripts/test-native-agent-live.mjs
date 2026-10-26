// Opt-in real Magnus evaluation against a network-isolated synthetic employer.
// Build first, then: node scripts/test-native-agent-live.mjs --live
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
if (!process.argv.includes('--live')) throw new Error('Pass --live to spend the configured model budget on synthetic data.');
const directory = mkdtempSync(join(tmpdir(), 'owtomate-native-live-'));
Object.assign(process.env, { DATA_DIR: directory, DRY_RUN: 'true', ALLOW_EXTERNAL_APPLY: 'true', APPLICATION_REVIEW_MODE: '', COST_TRACKING: 'false', RESUME_SELECT: 'fixture-cv', FORM_CORPUS_DIR: join(directory, 'corpus') });
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), 'Alex Fixture. Software developer with two years of TypeScript and React work. Australian citizen. Available two weeks after offer. Contact alex@example.invalid.');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'fixture-cv', label: 'Fixture CV', fileName: 'Fixture CV.txt' }]));
const { config } = await import('../dist/config.js');
const { runApplicationAgent } = await import('../dist/agent/loop.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
let blockedRealRequests = 0;
try {
  const context = await browser.newContext();
  const html = `<main><h1>Fictional Software Developer application</h1><form onsubmit="event.preventDefault();if(!document.querySelector('#name').value||!document.querySelector('#email').value||!document.querySelector('#salary').checkValidity()){document.querySelector('#error').textContent='Complete the required contact details and hourly rate';return}document.querySelector('#personal').hidden=true;document.querySelector('#documents').hidden=false">
    <section id=personal><label>Full name<input id=name required oninput="window.nameSaved=this.value;let copy=this.cloneNode(true);copy.value=this.value;this.replaceWith(copy)"></label><label>Email<input id=email type=email required></label><label>Expected hourly rate in AUD<input id=salary type=number min=20 max=100 step=.01 required></label><button>Continue to documents</button></section><p id=error role=alert></p></form>
    <section id=documents hidden><h2>Documents</h2><p>Write a cover letter in the embedded editor and attach your CV, then send your application.</p><iframe id=letter-editor title="Cover letter editor" srcdoc="<body contenteditable='true' aria-label='Cover letter'></body>"></iframe><label>Resume<input id=cv type=file accept=.txt required></label><button id=send onclick="if(!document.querySelector('#letter-editor').contentDocument.body.innerText.trim()||!document.querySelector('#cv').files.length){document.querySelector('#error').textContent='Cover letter and CV are required';return}window.submissions=(window.submissions||0)+1;window.letter=document.querySelector('#letter-editor').contentDocument.body.innerText;document.querySelector('main').innerHTML='<h1>Application received</h1><p>Receipt SYNTHETIC-001</p>'">Submit application</button></section></main>`;
  await context.route('**/*', route => {
    if (!new URL(route.request().url()).hostname.endsWith('.invalid')) { blockedRealRequests++; return route.abort(); }
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  const page = await context.newPage();
  const url = 'https://employer.native.invalid/apply/synthetic';
  await page.goto(url);
  const started = Date.now();
  const result = await runApplicationAgent({ page, simulation: 'isolated-form',
    job: { id: 'native-live-synthetic', title: 'Software Developer', company: 'Fictional Employer', location: 'Sydney', url, platform: 'seek', applicationMode: 'external', source: 'chosen', description: 'Synthetic TypeScript developer vacancy. The candidate explicitly chose this job. Expected rate is hourly. Include the candidate CV and a short tailored cover letter.' },
    profile: { name: 'Alex Fixture', email: 'alex@example.invalid', phone: '0400000000', nationality: 'Australian', workRights: 'Citizen', workRightsCountry: 'Australia', expectedSalary: 'AUD 35 per hour', noticePeriod: 'Two weeks', willingToRelocate: false, skills: ['TypeScript', 'React'], experienceSummary: 'Two years of TypeScript and React development.', excludedDomains: [], securityClearance: 'None held' }, log: () => {} });
  const received = await page.evaluate(() => ({ count: window.submissions || 0, letter: window.letter || '', name: window.nameSaved }), undefined, undefined, false);
  const report = new URL('../output/native-agent-live.json', import.meta.url);
  mkdirSync(new URL('../output/', import.meta.url), { recursive: true });
  writeFileSync(report, JSON.stringify({ result, received, text: await page.locator('body').innerText(), trace: JSON.parse(readFileSync(join(directory, 'traces', 'native-live-synthetic.json'), 'utf8')) }, null, 2));
  assert.equal(received.count, 1, `Synthetic form must actually receive one send: ${JSON.stringify(result.outcome)}`);
  assert.equal(received.name, 'Alex Fixture'); assert.match(received.letter, /Alex/);
  assert.doesNotMatch(received.letter, /\u2014/); assert.match(await page.locator('main').innerText(), /SYNTHETIC-001/);
  assert.equal(result.outcome.status, 'rehearsed');
  console.log(JSON.stringify({ status: 'passed', elapsedMs: Date.now()-started, modelTurns: result.steps, usage: result.usage, isolated: true, realEmployerSubmissions: 0, blockedRealRequests, applicationBudgetUsd: config.celeris.budgetUsdPerApplication }));
} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
