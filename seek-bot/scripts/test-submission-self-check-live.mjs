// Real MiniMax decisions with the production tools. All employer responses are
// controlled by a network-isolated fixture outside the browser, not model prose.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';

if (!process.argv.includes('--live')) throw Error('Pass --live to use the configured MiniMax API on fictional applications.');
const directory = mkdtempSync(join(tmpdir(), 'owtomate-submission-self-check-'));
Object.assign(process.env, {
  APPLICATION_AI_MODEL: 'minimax', DATA_DIR: directory, DRY_RUN: 'true', COST_TRACKING: 'false',
  ALLOW_EXTERNAL_APPLY: 'true', APPLICATION_REVIEW_MODE: '', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false',
  RESUME_SELECT: 'fixture-cv', FORM_CORPUS_DIR: join(directory, 'corpus'), KEYWORDS: 'data analyst', TARGET_ROLE: '',
  COVER_LETTER_MODE: 'tailored', COVER_LETTER_TEXT_B64: '', COVER_LETTER_INSTRUCTIONS: '', AI_INSTRUCTIONS_B64: '',
  AGENT_BUDGET_USD: '0.15', AGENT_PROGRESS_BUDGET_USD: '0.30',
});
mkdirSync(join(directory, 'resumes'));
const history = 'Alex Fixture. Data Analyst at Fixture Analytics from February 2024 to October 2026. Bachelor of Science at Fixture University, graduated 2023. SQL, Python and Power BI. Lives in Sydney, Australia. Australian citizen.';
writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), history);
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'fixture-cv', label: 'Fixture CV', fileName: 'Fixture CV.txt', isDefault: true }]));
const { config } = await import('../dist/config.js');
const { runApplicationAgent } = await import('../dist/agent/loop.js');
const { applicationAgentIdentity } = await import('../dist/application-model.js');
assert.equal(config.dryRun, true);
assert.equal(applicationAgentIdentity().selection, 'minimax');
if (!process.env.OPENROUTER_API_KEY) throw Error('OPENROUTER_API_KEY is not configured.');

const cases = ['confirmed', 'validation-recovery', 'unconfirmed-success-url'];
const receipt = 'Your application for Data Analyst at Fictional Employer has been received for Alex Fixture. Receipt SELF-CHECK-123.';
const validation = 'Please provide at least one work experience entry. Please provide at least one education entry.';
const html = fixture => `<!doctype html><style>body{font:18px Arial;margin:30px;max-width:950px}label{display:block;margin:15px 0}input,textarea,button{font:inherit;padding:8px}textarea{display:block;width:90%;height:80px}[role=alert]{color:#a00}</style>
<main><h1>Data Analyst at Fictional Employer</h1><p>Sydney, Australia. Application for Alex Fixture (alex@example.invalid).</p>
<label>Full name<input id=name value="Alex Fixture" readonly></label><label>Email<input id=email value="alex@example.invalid" readonly></label>
${fixture === 'validation-recovery' ? `<p id=errors role=alert>${validation}</p><label>Work experience<textarea id=work></textarea></label><button type=button onclick="saveEntry('work')">Save work experience</button><p id=workResult></p><label>Education<textarea id=education></textarea></label><button type=button onclick="saveEntry('education')">Save education</button><p id=educationResult></p>` : '<p id=errors role=alert></p>'}
<p id=result>No application has been submitted yet.</p><button id=send type=button onclick="submitApplication()">Submit application</button></main>
<script>async function saveEntry(kind){const r=await fetch('/save-'+kind,{method:'POST',body:JSON.stringify({value:document.getElementById(kind).value})});const data=await r.json();document.getElementById(kind+'Result').textContent=data.message;if(r.ok)document.getElementById(kind).readOnly=true;}
async function submitApplication(){const r=await fetch('/submit',{method:'POST'});const data=await r.json();document.querySelector('#result').textContent=data.message;document.querySelector('#errors').textContent=data.errors||'';if(data.pending){history.replaceState({},'', '/apply/success');document.querySelector('#send').disabled=true;}if(data.accepted)document.querySelector('main').innerHTML='<h1>Data Analyst at Fictional Employer</h1><p>'+data.message+'</p>';}</script>`;

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch;
const results = [];
try {
  for (const fixture of cases) {
    const state = { posts: 0, accepted: 0, saved: new Set(), finished: [], calls: 0, readAfterPost: false };
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname !== 'submission.fixture.invalid') return route.abort();
      const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname.startsWith('/save-') && request.method() === 'POST') {
        const kind = url.pathname.slice(6), value = JSON.parse(request.postData() || '{}').value || '';
        const valid = kind === 'work' ? /Data Analyst/i.test(value) && /Fixture Analytics/i.test(value)
          : kind === 'education' && /Fixture University/i.test(value) && /Bachelor|BSc|B\.Sc/i.test(value);
        if (valid) state.saved.add(kind);
        return reply({ message: valid ? `${kind} saved` : `Enter the candidate's actual ${kind} details.` }, valid ? 200 : 422);
      }
      if (url.pathname === '/submit' && request.method() === 'POST') {
        state.posts++;
        if (fixture === 'unconfirmed-success-url') return reply({ pending: true, message: 'Processing request. Receipt cannot be confirmed. Check later; do not send another application.' }, 202);
        if (fixture === 'validation-recovery' && state.saved.size !== 2) return reply({ message: 'Application was not submitted.', errors: validation }, 422);
        state.accepted++;
        return reply({ accepted: true, message: receipt });
      }
      return route.fulfill({ contentType: 'text/html', body: html(fixture) });
    });
    const page = await context.newPage(), url = `https://submission.fixture.invalid/apply/${fixture}`;
    await page.goto(url);
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).hostname, 'openrouter.ai', 'No real employer or mailbox calls are allowed');
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools?.length) {
        state.calls++;
        assert.equal(body.model, applicationAgentIdentity().model);
        assert.equal(body.reasoning?.effort, 'high');
        if (state.posts) {
          const latest = body.messages.filter(message => message.role === 'user').at(-1);
          // The production observation, rather than the fixture's hidden state,
          // must be delivered back to the actual model after the send.
          if (JSON.stringify(latest?.content).includes(fixture === 'unconfirmed-success-url' ? 'Receipt cannot be confirmed' : receipt)) state.readAfterPost = true;
        }
      }
      const response = await originalFetch(input, init);
      if (response.ok && body.tools?.length) {
        const payload = await response.clone().json();
        for (const call of payload.choices?.[0]?.message?.tool_calls ?? []) {
          if (call.function?.name !== 'finish') continue;
          try { state.finished.push(JSON.parse(call.function.arguments)); } catch { /* Dispatcher handles malformed arguments. */ }
        }
      }
      return response;
    };
    const started = Date.now();
    try {
      const result = await runApplicationAgent({ page, simulation: 'isolated-form',
        job: { id: `submission-self-check-${fixture}`, title: 'Data Analyst', company: 'Fictional Employer', location: 'Sydney', url,
          platform: 'smartrecruiters', source: 'chosen', applicationMode: 'external', description: 'Data Analyst using SQL, Python and Power BI.' },
        profile: { name: 'Alex Fixture', email: 'alex@example.invalid', phone: '0400000000', nationality: 'Australian', workRights: 'Citizen', workRightsCountry: 'Australia',
          expectedSalary: 'AUD 135000', noticePeriod: 'Two weeks', willingToRelocate: false, skills: ['SQL', 'Python', 'Power BI'],
          experienceSummary: history, excludedDomains: [], securityClearance: 'None held' }, log: () => {} });
      const final = state.finished.at(-1);
      assert.ok(final, 'The actual model must report its own final judgement');
      assert.ok(state.readAfterPost, 'A fresh employer response must reach the actual model before its final decision');
      assert.equal(state.posts, 1, 'Do not repeat an uncertain send or send after confirmation');
      assert.equal(result.submitPressed, true);
      if (fixture === 'unconfirmed-success-url') {
        assert.equal(state.accepted, 0);
        assert.equal(final.status, 'error');
        assert.match(final.reason, /^Submission unconfirmed:/i);
        assert.equal(result.outcome.status, 'error');
        assert.equal(result.outcome.retryable, false);
        assert.ok(state.finished.every(value => value.status !== 'applied'), 'No invented success may precede the truthful final result');
      } else {
        assert.equal(state.accepted, 1);
        if (fixture === 'validation-recovery') assert.equal(state.saved.size, 2, 'Both required entries must be accepted by the employer fixture');
        assert.equal(final.status, 'applied');
        assert.equal(final.receipt?.quote, receipt, 'Quote the complete actual receipt, not an invented summary');
        assert.equal(result.outcome.status, 'rehearsed');
      }
      results.push({ fixture, passed: true, finalStatus: final.status, posts: state.posts, accepted: state.accepted, savedEntries: state.saved.size,
        freshResponseRead: state.readAfterPost, model: applicationAgentIdentity().model, reasoning: 'high', calls: state.calls, usage: result.usage, elapsedMs: Date.now() - started });
    } catch (error) {
      process.exitCode = 1;
      results.push({ fixture, passed: false, error: error.message, posts: state.posts, accepted: state.accepted, calls: state.calls,
        finished: state.finished, pageText: await page.locator('body').innerText().catch(() => ''), elapsedMs: Date.now() - started });
    } finally { await context.close(); }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  mkdirSync(new URL('../output/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../output/submission-self-check-live.json', import.meta.url), JSON.stringify({ realEmployerSubmissions: 0, results }, null, 2));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-submission-self-check-'));
  rmSync(directory, { recursive: true, force: true });
}
