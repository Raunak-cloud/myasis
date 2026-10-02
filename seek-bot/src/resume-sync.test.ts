import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'patchright';

/**
 * Owtomate's résumé is the one a board sends: kept, selected or uploaded on
 * mock SEEK and Indeed documents steps. Fixture pages served under the
 * boards' own hosts, so nothing reaches a real board.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-resume-sync-'));
process.env.DATA_DIR = directory;
process.env.RESUME_ALLOW_UPLOAD = 'true';
mkdirSync(join(directory, 'resumes'));
const resumeFile = join(directory, 'resumes', 'Raunak_New_Resume (2).docx');
writeFileSync(resumeFile, 'resume version one');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([
  { id: '5', label: 'Raunak_New_Resume (2)', fileName: 'Raunak_New_Resume (2).docx', isDefault: true, uploadedAt: '2026-09-01', size: 18 },
]));
process.env.CELERIS_API_KEY = 'fixture-only';
// Every model check answers "nothing wrong, not a submit": this test is about the résumé, not the answers.
globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ problems: [], sends_application: false, unsafe: false, reason: 'fixture' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const { ensureChosenResume, documentChoices, addedAt } = await import('./resume-sync.js');
const { observe } = await import('./agent/observe.js');
const { executeTool } = await import('./agent/tools.js');
const { RunGuards } = await import('./agent/guards.js');
const { CostMeter } = await import('./agent/celeris.js');
const { loadResumes } = await import('./resume.js');
const chosen = loadResumes()[0];

/** A SEEK-like step: saved résumés as radios, an upload that saves and selects what it receives. */
const seekStep = (saved: Array<{ name: string; checked?: boolean; added?: string }>) => `<!doctype html><main>
  <h3>Resumé</h3>
  <div id="list">${saved.map((s, i) => `<div class="item"><label><input type="radio" name="resume" value="${i}" ${s.checked ? 'checked' : ''}> <strong>${s.name}</strong></label>${s.added ? `<span>Added ${s.added}</span>` : ''}</div>`).join('')}
  <label><input type="radio" name="resume" value="none"> Don't include a resumé</label></div>
  <label>Profile photo <input type="file" accept="image/*"></label>
  <button type="button">Upload</button><input id="doc" type="file" accept=".doc,.docx,.pdf,.txt,.rtf" style="display:none">
  <p>Accepted file types: .doc, .docx, .pdf, .txt and .rtf (5MB limit).</p>
  <button>Continue</button>
  <script>
    document.getElementById('doc').addEventListener('change', (event) => {
      const name = event.target.files[0].name;
      setTimeout(() => {
        const label = document.createElement('label');
        label.innerHTML = '<input type="radio" name="resume" checked> <strong></strong>';
        label.querySelector('strong').textContent = name;
        document.getElementById('list').prepend(label);
        label.querySelector('input').checked = true;
      }, 400);
    });
  </script></main>`;

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
let html = '';
const open = async (page: Page, url: string, body: string) => {
  html = body;
  await page.goto(url);
};
const checkedName = async (page: Page) => (await documentChoices(page)).find((c) => c.checked)?.name;
const record = () => JSON.parse(readFileSync(join(directory, 'resume-sync.json'), 'utf8'));
try {
  const page = await browser.newPage();
  await page.route(/https:\/\/(au\.seek\.com|smartapply\.indeed\.com|employer\.example)\/.*/, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  const seekUrl = 'https://au.seek.com/job/1/apply';

  // 1. Already selected on SEEK: kept, and the board's other résumés reported.
  await open(page, seekUrl, seekStep([{ name: 'Raunak_New_Resume (2).docx', checked: true }, { name: 'Raunak_Fullstack_Resume.docx' }]));
  let result = await ensureChosenResume(page, chosen);
  assert.equal(result.action, 'kept');
  const report = JSON.parse(readFileSync(join(directory, 'board-resumes.json'), 'utf8'));
  assert.deepEqual(report.seek.names, ['Raunak_Fullstack_Resume.docx'], 'the board-only résumé is reported');
  assert.equal(record().seek['5'].name, 'Raunak_New_Resume (2).docx', 'the copy is remembered by content');

  // 2. Saved but another preselected: Owtomate's is selected instead.
  await open(page, seekUrl, seekStep([{ name: 'Raunak_Fullstack_Resume.docx', checked: true }, { name: 'Raunak_New_Resume (2).docx' }]));
  result = await ensureChosenResume(page, chosen);
  assert.equal(result.action, 'selected');
  assert.equal(await checkedName(page), 'Raunak_New_Resume (2).docx');

  // 3. Not on the board at all: uploaded and selected.
  rmSync(join(directory, 'resume-sync.json'));
  await open(page, seekUrl, seekStep([{ name: 'Old_CV.pdf', checked: true }]));
  result = await ensureChosenResume(page, chosen);
  assert.equal(result.action, 'uploaded');
  assert.equal(await checkedName(page), 'Raunak_New_Resume (2).docx');

  // 4. Owtomate's file replaced since the board got it: the stale copy is not used; the new one goes up under a new name.
  writeFileSync(resumeFile, 'resume version two');
  await open(page, seekUrl, seekStep([{ name: 'Raunak_New_Resume (2).docx', checked: true }]));
  result = await ensureChosenResume(page, chosen);
  assert.equal(result.action, 'uploaded', 'a stale copy is replaced');
  assert.match(String(await checkedName(page)), /^Raunak_New_Resume \(2\) \(updated \d{4}-\d{2}-\d{2}\)\.docx$/);
  // ...and next time that new copy is simply kept.
  await open(page, seekUrl, seekStep([{ name: String(await checkedName(page)), checked: true }, { name: 'Raunak_New_Resume (2).docx' }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'kept');

  // 5. Indeed keeps one file, as PDF: the same résumé by name is kept.
  rmSync(join(directory, 'resume-sync.json'));
  await open(page, 'https://smartapply.indeed.com/beta/indeedapply/form/resume-selection-module/resume-selection',
    '<main><div role="radiogroup"><div role="radio" aria-checked="true" aria-label="Raunak_New_Resume (2).pdf"></div></div><button>Continue</button></main>');
  result = await ensureChosenResume(page, chosen);
  assert.equal(result.action, 'kept');

  // 6. Not a board, or no résumé choice on the page: left alone.
  await open(page, 'https://employer.example/apply', seekStep([{ name: 'Old_CV.pdf', checked: true }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'none', 'employer sites are not touched here');
  await open(page, seekUrl, '<main><label>Phone<input></label><button>Continue</button></main>');
  assert.equal((await ensureChosenResume(page, chosen)).action, 'none', 'a step without résumés is not touched');

  // 8. Reading when a copy was added.
  const now = Date.UTC(2026, 9, 2, 3, 0);
  const day = 24 * 60 * 60_000;
  assert.equal(addedAt('Added 20 days ago', now)?.at, now - 20 * day);
  assert.equal(addedAt('Added about 1 month ago', now)?.at, now - 30 * day);
  assert.equal(addedAt('Added just now', now)?.at, now);
  assert.equal(addedAt('Added 3 hours ago', now)?.at, now - 3 * 60 * 60_000);
  assert.equal(addedAt('September 19', now)?.at, Date.UTC(2026, 8, 19));
  assert.equal(addedAt('December 30', now)?.at, Date.UTC(2025, 11, 30), 'a date without a year is never in the future');
  assert.equal(addedAt('Raunak_New_Resume.docx', now), null);

  // 9. Replaced on SEEK under the same name: not Owtomate's, so Owtomate's copy goes up and the person is told.
  rmSync(join(directory, 'resume-sync.json'));
  writeFileSync(resumeFile, 'resume version three');
  await open(page, seekUrl, seekStep([{ name: 'Raunak_New_Resume (2).docx', checked: true, added: '20 days ago' }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'kept', 'first sighting is trusted and dated');
  assert.ok(Math.abs(record().seek['5'].boardAddedAt - (Date.now() - 20 * day)) < 60_000, 'the board copy is dated from what the board said');
  // The next day the same file still reads as the same copy...
  await open(page, seekUrl, seekStep([{ name: 'Raunak_New_Resume (2).docx', checked: true, added: '21 days ago' }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'kept', 'a relative date drifting with time is the same copy');
  // ...but one added just now, under the same name, is the person's own new file.
  await open(page, seekUrl, seekStep([{ name: 'Raunak_New_Resume (2).docx', checked: true, added: 'just now' }]));
  result = await ensureChosenResume(page, chosen);
  assert.equal(result.action, 'uploaded', "a same-named copy added later is replaced by Owtomate's");
  assert.match(String(await checkedName(page)), /\(updated \d{4}-\d{2}-\d{2}\)\.docx$/);
  const told = JSON.parse(readFileSync(join(directory, 'board-resumes.json'), 'utf8'));
  assert.equal(told.seekReplaced?.[0]?.name, 'Raunak_New_Resume (2).docx', 'the dashboard is told which copy was replaced');

  // 10. Indeed's dated single file, replaced later under the same name.
  rmSync(join(directory, 'resume-sync.json'));
  const indeedUrl = 'https://smartapply.indeed.com/beta/indeedapply/form/resume-selection-module/resume-selection';
  const indeedStep = (date: string) => `<main><div role="radiogroup"><div class="card"><div role="radio" aria-checked="true" aria-label="Raunak_New_Resume (2).pdf"></div><span>${date}</span></div></div>
    <input type="file" accept=".pdf,.docx" onchange="setTimeout(() => { const c = document.querySelector('[role=radio]'); c.setAttribute('aria-label', this.files[0].name); }, 300)"><button>Continue</button></main>`;
  await open(page, indeedUrl, indeedStep('September 19'));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'kept');
  await open(page, indeedUrl, indeedStep('September 19'));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'kept', 'the same Indeed file is kept');
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  await open(page, indeedUrl, indeedStep(today));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'uploaded', "Indeed's file replaced today is replaced by Owtomate's");

  // 7. Through the agent: pressing Continue on SEEK's documents step settles the résumé first.
  rmSync(join(directory, 'resume-sync.json'));
  await open(page, seekUrl, seekStep([{ name: 'Raunak_Fullstack_Resume.docx', checked: true }, { name: 'Raunak_New_Resume (2).docx' }]));
  const lines: string[] = [];
  const ctx = {
    page, profile: { name: 'Fixture', phone: '0400000000', email: 'f@example.com', nationality: 'Australian', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' },
    job: { id: '1', title: 'Developer', company: 'Fixture Co', location: 'Sydney', url: seekUrl },
    observation: await observe(page), captured: [], actions: [], log: (line: string) => lines.push(line),
    guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) }),
  } as unknown as Parameters<typeof executeTool>[0];
  const continueRef = ctx.observation.actions.find((action) => /^continue$/i.test(action.text))?.ref;
  assert.ok(continueRef, 'the fixture has a Continue action');
  await executeTool(ctx, 'click', { ref: continueRef, reason: 'Continue to employer questions' });
  assert.equal(await checkedName(page), 'Raunak_New_Resume (2).docx', "Continue left the step with Owtomate's résumé selected");
  assert.equal((ctx as { resumeName?: string }).resumeName, 'Raunak_New_Resume (2).docx', 'the application records the file sent');
  assert.ok(lines.some((line) => /résumé "Raunak_New_Resume \(2\)\.docx" selected on SEEK/.test(line)), lines.join(' | '));

  assert.ok(existsSync(join(directory, 'resume-sync.json')));
  console.log('PASS: SEEK and Indeed send Owtomate\'s résumé: kept, selected, uploaded, replaced when stale; board-only ones reported');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
