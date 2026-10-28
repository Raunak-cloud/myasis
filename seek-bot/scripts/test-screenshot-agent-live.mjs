// Real Magnus, fictional candidates and network-isolated employer forms only.
// Build first: node scripts/test-screenshot-agent-live.mjs --live
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

if (!process.argv.includes('--live')) throw new Error('Pass --live to spend the configured Magnus budget on fictional applications.');
const directory = mkdtempSync(join(tmpdir(), 'owtomate-screenshot-live-'));
Object.assign(process.env, {
  DATA_DIR: directory, DRY_RUN: 'true', ALLOW_EXTERNAL_APPLY: 'true', APPLICATION_REVIEW_MODE: '', COST_TRACKING: 'false',
  APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'true', RESUME_SELECT: 'fixture-cv', FORM_CORPUS_DIR: join(directory, 'corpus'),
  KEYWORDS: 'software developer', TARGET_ROLE: '', COVER_LETTER_MODE: 'tailored', COVER_LETTER_TEXT_B64: '',
  COVER_LETTER_INSTRUCTIONS: '', AI_INSTRUCTIONS_B64: '', AGENT_BUDGET_USD: '0.20', AGENT_PROGRESS_BUDGET_USD: '0.50',
  AGENT_MAX_MS: '180000',
});
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), 'Alex Fixture. Software developer with two years of TypeScript and React work. Australian citizen living in Sydney, Australia. Available weekdays, two weeks after offer. Expected rate AUD 35 per hour. Contact alex@example.invalid.');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'fixture-cv', label: 'Fixture CV', fileName: 'Fixture CV.txt', isDefault: true }]));
const { config } = await import('../dist/config.js');
const { runApplicationAgent } = await import('../dist/agent/loop.js');
if (!config.celeris.apiKey) throw new Error('CELERIS_API_KEY is not configured.');
const cases = [
  { id: 'native', controls: `<label>Country of residence<select id=country required><option value="">Choose country</option><option value=au>Australia</option><option value=nz>New Zealand</option></select></label>
    <label>Expected hourly rate in AUD<input id=salary type=number min=20 max=100 step=.01 required></label>`,
    valid: "document.querySelector('#country').value==='au' && document.querySelector('#salary').value==='35'" },
  { id: 'dropdown-radio', controls: `<p>Country of residence</p><button type=button id=country aria-haspopup=listbox aria-expanded=false onclick="this.setAttribute('aria-expanded','true');document.querySelector('#countries').hidden=false">Choose country</button>
    <div id=countries role=listbox hidden><button type=button role=option onclick="window.country='Australia';document.querySelector('#country').textContent='Australia';document.querySelector('#country').setAttribute('aria-expanded','false');document.querySelector('#countries').hidden=true">Australia</button><button type=button role=option>New Zealand</button></div>
    <fieldset><legend>Available to work weekdays?</legend><label><input type=radio name=weekdays value=yes required>Yes</label><label><input type=radio name=weekdays value=no>No</label></fieldset>
    <label><input type=checkbox id=consent required>I agree to processing this fictional test application</label>`,
    valid: "window.country==='Australia' && document.querySelector('input[name=weekdays]:checked')?.value==='yes' && document.querySelector('#consent').checked" },
  { id: 'autocomplete', controls: `<label>City of residence<input id=city required aria-autocomplete=list aria-controls=cities oninput="this.dataset.committed='false';document.querySelector('#cities').hidden=!this.value.toLowerCase().startsWith('syd')"></label>
    <div id=cities role=listbox hidden><button type=button role=option onclick="document.querySelector('#city').value='Sydney';document.querySelector('#city').dataset.committed='true';this.parentElement.hidden=true">Sydney, Australia</button></div>
    <p>Select the suggested city after typing. Typed text alone is not accepted.</p>`,
    valid: "document.querySelector('#city').value==='Sydney' && document.querySelector('#city').dataset.committed==='true'" },
];
const html = (fixture) => `<!doctype html><style>body{font:18px Arial;margin:30px;max-width:900px}label{display:block;margin:16px 0}input,select,textarea,button{font:inherit;padding:8px}textarea{display:block;width:90%;height:130px}[role=alert]{color:#a00}</style>
  <main><h1>Fictional Software Developer application</h1><p>Fixture Employer, Sydney. This is an isolated test.</p>
  <form onsubmit="event.preventDefault();if(!(${fixture.valid})){document.querySelector('#error').textContent='Complete the required selections using the candidate evidence before continuing';return}window.contact={name:document.querySelector('#name').value,email:document.querySelector('#email').value};document.querySelector('#contact').hidden=true;document.querySelector('#documents').hidden=false">
    <section id=contact><label>Full name<input id=name required></label><label>Email<input id=email type=email required></label>${fixture.controls}<button>Continue to documents</button></section></form>
  <p id=error role=alert></p><section id=documents hidden><h2>Documents</h2><label>Cover letter<textarea id=letter required></textarea></label><label>Resume<input id=cv type=file accept=.txt required></label>
    <button id=send onclick="if(!document.querySelector('#letter').value.trim()||!document.querySelector('#cv').files.length){document.querySelector('#error').textContent='Cover letter and CV are required';return}window.submissions=(window.submissions||0)+1;window.sentLetter=document.querySelector('#letter').value;document.querySelector('main').innerHTML='<h1>Application received</h1><p>Receipt SCREENSHOT-${fixture.id}</p>'">Submit application</button></section></main>`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch;
const results = [];
let blockedRealRequests = 0;
try {
  for (const fixture of cases) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.route('**/*', route => {
      if (!new URL(route.request().url()).hostname.endsWith('.invalid')) { blockedRealRequests++; return route.abort(); }
      return route.fulfill({ contentType: 'text/html', body: html(fixture) });
    });
    const page = await context.newPage();
    const url = `https://employer.screenshots.invalid/apply/${fixture.id}`;
    await page.goto(url);
    const requests = [];
    globalThis.fetch = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.model === 'celeris-1-magnus' && body.tools?.length) {
        const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
        assert.equal(images.length, 1, 'every decision must receive exactly one current screenshot');
        const latest = body.messages.filter(message => message.role === 'user').at(-1);
        assert.equal(latest.content.filter(part => part.type === 'image_url').length, 1);
        requests.push({ images: images.length, payloadBytes: Buffer.byteLength(String(init.body)) });
      }
      return originalFetch(input, init);
    };
    const started = Date.now();
    try {
      const result = await runApplicationAgent({ page, simulation: 'isolated-form',
        job: { id: `screenshot-live-${fixture.id}`, title: 'Software Developer', company: 'Fixture Employer', location: 'Sydney', url,
          platform: 'seek', applicationMode: 'external', source: 'chosen', description: 'Fictional TypeScript developer role in Sydney. Include the selected CV and a short tailored cover letter. The candidate lives in Sydney, Australia, is available weekdays, expects AUD 35 per hour and explicitly agrees to processing this fictional test application.' },
        profile: { name: 'Alex Fixture', email: 'alex@example.invalid', phone: '0400000000', nationality: 'Australian', workRights: 'Citizen', workRightsCountry: 'Australia',
          expectedSalary: 'AUD 35 per hour', noticePeriod: 'Two weeks', willingToRelocate: false, skills: ['TypeScript', 'React'],
          experienceSummary: 'Two years of TypeScript and React development. Lives in Sydney, Australia. Available weekdays. Agrees to processing fictional test applications.', excludedDomains: [], securityClearance: 'None held' },
        log: line => { if (/screenshot test|failed|budget/i.test(line)) console.log(`[${fixture.id}] ${line}`); } });
      const received = await page.evaluate(() => ({ count: window.submissions || 0, contact: window.contact, letter: window.sentLetter || '' }), undefined, undefined, false);
      assert.equal(received.count, 1, `Expected one fictional send: ${JSON.stringify(result.outcome)}`);
      assert.equal(received.contact.name, 'Alex Fixture');
      assert.equal(received.contact.email, 'alex@example.invalid');
      assert.ok(received.letter.trim());
      assert.match(await page.locator('main').innerText(), new RegExp(`SCREENSHOT-${fixture.id}`));
      assert.equal(result.outcome.status, 'rehearsed');
      const record = { fixture: fixture.id, passed: true, elapsedMs: Date.now() - started, modelTurns: result.steps, usage: result.usage, requests, result };
      results.push(record);
      console.log(JSON.stringify({ ...record, result: undefined, requests: requests.length, maxImagesPerRequest: Math.max(...requests.map(request => request.images)) }));
    } catch (error) {
      results.push({ fixture: fixture.id, passed: false, elapsedMs: Date.now() - started, error: error.message, requests, pageText: await page.locator('body').innerText().catch(() => '') });
      console.log(JSON.stringify({ fixture: fixture.id, passed: false, error: error.message }));
      process.exitCode = 1;
    } finally { await context.close(); }
  }
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  mkdirSync(new URL('../output/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../output/screenshot-agent-live.json', import.meta.url), JSON.stringify({ screenshotMode: 'every-turn', viewport: { width: 1440, height: 960 }, realEmployerSubmissions: 0, blockedRealRequests, results }, null, 2));
  rmSync(directory, { recursive: true, force: true });
}
