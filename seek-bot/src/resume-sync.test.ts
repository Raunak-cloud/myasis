import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'patchright';

/**
 * Only a board copy Owtomate uploaded itself is sent; anything else, even
 * under the same name, is replaced by Owtomate's exact file. Mock SEEK and
 * Indeed documents steps. Fixture pages served under the
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

  const today = new Date().toISOString().slice(0, 10);
  const told = () => JSON.parse(readFileSync(join(directory, 'board-resumes.json'), 'utf8'));
  const owtomateCopy = `Raunak_New_Resume (2) (updated ${today}).docx`;

  // 1. SEEK holds the person's own copy under the same name: never trusted, since it may differ in any
  //    detail. Owtomate's exact file goes up under a name of its own, is selected, and the person is told.
  await open(page, seekUrl, seekStep([{ name: 'Raunak_New_Resume (2).docx', checked: true, added: '20 days ago' }, { name: 'Raunak_Fullstack_Resume.docx' }]));
  let result = await ensureChosenResume(page, chosen);
  assert.equal(result.action, 'uploaded', 'a copy Owtomate did not upload is not sent');
  assert.equal(await checkedName(page), owtomateCopy);
  assert.deepEqual(told().seek.names, ['Raunak_Fullstack_Resume.docx'], 'the board-only résumé is reported');
  assert.equal(told().seekReplaced?.[0]?.name, 'Raunak_New_Resume (2).docx', 'the person is told their same-named copy was not used');
  assert.equal(record().seek['5'].uploadedByOwtomate, true);

  // 2. Owtomate's own copy, selected: kept.
  await open(page, seekUrl, seekStep([{ name: owtomateCopy, checked: true, added: 'just now' }, { name: 'Raunak_New_Resume (2).docx' }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'kept');

  // 3. Owtomate's copy saved but the person's preselected: Owtomate's is selected.
  await open(page, seekUrl, seekStep([{ name: 'Raunak_New_Resume (2).docx', checked: true }, { name: owtomateCopy, added: 'just now' }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'selected');
  assert.equal(await checkedName(page), owtomateCopy);

  // 4. Nothing of Owtomate's there and no clash: uploaded under its own file name.
  rmSync(join(directory, 'resume-sync.json'));
  await open(page, seekUrl, seekStep([{ name: 'Old_CV.pdf', checked: true }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'uploaded');
  assert.equal(await checkedName(page), 'Raunak_New_Resume (2).docx');

  // 5. Owtomate's file changed since: its older copy is not sent; the new one goes up beside it, unreported.
  writeFileSync(resumeFile, 'resume version two');
  const reportedBefore = told().seekReplaced?.length ?? 0;
  await open(page, seekUrl, seekStep([{ name: 'Raunak_New_Resume (2).docx', checked: true, added: 'just now' }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'uploaded', 'a stale Owtomate copy is replaced');
  assert.equal(await checkedName(page), owtomateCopy);
  assert.equal(told().seekReplaced?.length ?? 0, reportedBefore, "Owtomate's own older copy is not the person's");

  // 6. The person replaces Owtomate's copy on SEEK under the same name, later: caught by the date,
  //    and the new upload takes a name no copy on the board has.
  await open(page, seekUrl, seekStep([{ name: owtomateCopy, checked: true, added: 'just now' }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'kept', "Owtomate's own copy, as uploaded");
  const entry = record().seek['5'];
  entry.boardAddedAt -= 3 * 24 * 60 * 60_000; // as if Owtomate uploaded it three days ago
  writeFileSync(join(directory, 'resume-sync.json'), JSON.stringify({ seek: { '5': entry } }));
  await open(page, seekUrl, seekStep([{ name: owtomateCopy, checked: true, added: 'just now' }, { name: 'Raunak_New_Resume (2).docx', added: '20 days ago' }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'uploaded', "a same-named copy added later is the person's, not Owtomate's");
  assert.equal(await checkedName(page), `Raunak_New_Resume (2) (updated ${today} 2).docx`);
  assert.equal(told().seekReplaced.at(-1).name, owtomateCopy, 'and the person is told');

  // 7. Indeed keeps one file: the person's is replaced by Owtomate's exact file, which is kept from then on.
  rmSync(join(directory, 'resume-sync.json'));
  const indeedUrl = 'https://smartapply.indeed.com/beta/indeedapply/form/resume-selection-module/resume-selection';
  const indeedStep = (name: string, date: string) => `<main><div role="radiogroup"><div class="card"><div role="radio" aria-checked="true" aria-label="${name}"></div><span>${date}</span></div></div>
    <input type="file" accept=".pdf,.docx" onchange="setTimeout(() => { document.querySelector('[role=radio]').setAttribute('aria-label', this.files[0].name); }, 300)"><button>Continue</button></main>`;
  await open(page, indeedUrl, indeedStep('Raunak_New_Resume (2).pdf', 'September 19'));
  result = await ensureChosenResume(page, chosen);
  assert.equal(result.action, 'uploaded', "Indeed's own file is replaced by Owtomate's");
  const indeedCopy = (result as { name: string }).name;
  await open(page, indeedUrl, indeedStep(indeedCopy, new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'kept', "Owtomate's Indeed copy is kept");

  // 8. Not a board, or no résumé choice on the page: left alone.
  await open(page, 'https://employer.example/apply', seekStep([{ name: 'Old_CV.pdf', checked: true }]));
  assert.equal((await ensureChosenResume(page, chosen)).action, 'none', 'employer sites are not touched here');
  await open(page, seekUrl, '<main><label>Phone<input></label><button>Continue</button></main>');
  assert.equal((await ensureChosenResume(page, chosen)).action, 'none', 'a step without résumés is not touched');

  // 9. Reading when a copy was added.
  const now = Date.UTC(2026, 9, 2, 3, 0);
  const day = 24 * 60 * 60_000;
  assert.equal(addedAt('Added 20 days ago', now)?.at, now - 20 * day);
  assert.equal(addedAt('Added about 1 month ago', now)?.at, now - 30 * day);
  assert.equal(addedAt('Added just now', now)?.at, now);
  assert.equal(addedAt('Added 3 hours ago', now)?.at, now - 3 * 60 * 60_000);
  assert.equal(addedAt('September 19', now)?.at, Date.UTC(2026, 8, 19));
  assert.equal(addedAt('December 30', now)?.at, Date.UTC(2025, 11, 30), 'a date without a year is never in the future');
  assert.equal(addedAt('Raunak_New_Resume.docx', now), null);

  // 10. Through the agent: pressing Continue on SEEK's documents step settles the résumé first.
  rmSync(join(directory, 'resume-sync.json'));
  await open(page, seekUrl, seekStep([{ name: 'Raunak_Fullstack_Resume.docx', checked: true }]));
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
  assert.ok(lines.some((line) => /résumé "Raunak_New_Resume \(2\)\.docx" uploaded from Owtomate and selected on SEEK/.test(line)), lines.join(' | '));

  assert.ok(existsSync(join(directory, 'resume-sync.json')));
  console.log("PASS: only copies Owtomate uploaded are sent; the person's same-named copies, stale copies and later replacements are replaced by Owtomate's exact file");
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
