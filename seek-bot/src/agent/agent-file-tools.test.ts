import { createReadinessFixtureReply } from './readiness-fixture.js';
const readinessFixtureReply = createReadinessFixtureReply();
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { PreparedApplication } from '../application-review-types.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-native-files-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false',
  FORM_CORPUS_DIR: join(directory, 'corpus'), ALLOW_EXTERNAL_APPLY: 'true' });
const { config } = await import('../config.js');
const { AgentFiles } = await import('./agent-files.js');
const { runAgentOnlyApplication } = await import('./agent-only.js');
const { extractText } = await import('../knowledge.js');
config.dryRun = false;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const fetchBefore = globalThis.fetch;
try {
  mkdirSync(join(directory, 'resumes'));
  const pdf = Buffer.from('%PDF-1.4\nOriginal candidate document bytes\n%%EOF');
  writeFileSync(join(directory, 'resumes', 'Original.pdf'), pdf);
  writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Original candidate CV.');
  writeFileSync(join(directory, 'resumes.json'), JSON.stringify([
    { id: 'cv', label: 'Original PDF CV', fileName: 'Original.pdf' },
    { id: 'other', label: 'Text CV', fileName: 'CV.txt' },
  ]));
  const text = 'Dear hiring team,\n\nFirst factual paragraph.\n\nSecond factual paragraph.\n\nKind regards,\nFixture Applicant';
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid')
    ? route.fulfill({ contentType: 'text/html', body: `<main><form onsubmit="event.preventDefault();window.sent++;document.querySelector('main').textContent='Application received: NATIVE-FILES'">
      <label>Unused attachment<input type=file id=unused></label>
      <section id=cv-section><label>Resume<input type=file id=cv accept='doc,docx,pdf,rtf' onchange="window.original=this.files[0]"></label></section>
      <p>Cover letter must be DOCX.</p><input type=file id=letter hidden accept='.docx' onchange="window.letter=this.files[0]">
      <button id=choose type=button onclick="document.querySelector('#letter').click()">Choose cover letter</button>
      <button id=send>Submit application</button></form></main>` }) : route.abort());
  const page = await context.newPage();
  await page.goto('https://employer.files.invalid/apply');
  await page.evaluate('window.sent=0', undefined, undefined, false);
  let turn = 0, fileId = '';
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const reviewReply = readinessFixtureReply(body); if (reviewReply) return reviewReply;
    assert.ok(body.tools?.length, 'no secondary model or upload reviewer');
    const tools = body.tools.map((item: { function: { name: string } }) => item.function.name);
    assert.ok(!tools.includes('upload_document'), 'the custom upload handler is removed');
    let calls;
    switch (turn++) {
      case 0:
        calls = [{ name: 'browser_action', args: { action: 'set_input_files', file_ids: ['cv'], locator: { by: 'label', value: 'Resume', within: '#cv-section' } } }]; break;
      case 1:
        assert.match(JSON.stringify(body.messages.at(-1)), /Original.pdf/, 'chosen CV metadata is retained before save_progress');
        assert.deepEqual(Buffer.from(await page.evaluate('(async()=>Array.from(new Uint8Array(await window.original.arrayBuffer())))()', undefined, undefined, false)), pdf);
        assert.equal(await page.locator('#unused').evaluate(node => (node as HTMLInputElement).files?.length), 0);
        calls = [{ name: 'create_file', args: { name: 'Cover letter.docx', text, format: 'docx' } }]; break;
      case 2: {
        const file = JSON.parse(body.messages.filter((item: { role: string }) => item.role === 'tool').at(-1).content);
        assert.equal(file.format, 'docx'); fileId = file.file_id;
        assert.equal(await page.locator('#letter').evaluate(node => (node as HTMLInputElement).files?.length), 0, 'file creation does not upload');
        calls = [{ name: 'browser_action', args: { action: 'set_input_files', file_ids: [fileId], selector: '#choose', file_chooser: true } }]; break;
      }
      case 3:
        assert.equal(await page.evaluate('window.letter.name', undefined, undefined, false), 'Cover letter.docx');
        calls = [
          { name: 'save_progress', args: { note: 'Verified the original CV and DOCX letter attachments.', cover_letter: text } },
          { name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } },
        ]; break;
      case 4:
        calls = [{ name: 'finish', args: { status: 'applied', reason: 'Fictional employer receipt observed', evidence: 'Application received: NATIVE-FILES', receipt: { quote: 'Application received: NATIVE-FILES' } } }]; break;
      default: throw Error('Unexpected extra decision');
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({
      id: `files-${turn}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
    })) } }] });
  }) as typeof fetch;
  const result = await runAgentOnlyApplication({ page,
    job: { id: 'native-files', title: 'Fictional developer', company: 'Fixture Employer', location: 'Sydney', platform: 'workday', url: page.url() },
    profile: { name: 'Fixture Applicant', email: 'fixture@example.invalid', phone: '', skills: [] } as never, log: () => {} });
  assert.equal(result.outcome.status, 'applied');
  assert.equal(result.resumeUsed, 'cv');
  assert.equal(result.coverLetter, text);
  assert.equal(await page.evaluate('window.sent', undefined, undefined, false), 1);
  assert.equal(turn, 5);

  const files = new AgentFiles('file-service-check');
  const first = await files.create('Letter.docx', text, 'docx');
  const revised = await files.create('Letter.docx', text.replace('First factual', 'Revised factual'), 'docx');
  assert.notEqual(first.file_id, revised.file_id, 'revised content cannot reuse a stale conversion');
  assert.match(await extractText(files.resolve(revised.file_id).path), /Revised factual paragraph/);
  const converted = await files.convert('other', 'pdf');
  assert.equal(readFileSync(files.resolve(converted.file_id).path).subarray(0, 5).toString(), '%PDF-');
  assert.equal(readFileSync(join(directory, 'resumes', 'CV.txt'), 'utf8'), 'Original candidate CV.');
  assert.throws(() => files.resolve('../../another-user/private.pdf'), /file ID/);
  await assert.rejects(files.create('../leak.txt', text, 'txt'), /plain file name/);
  const approved = new AgentFiles('approved-file-check', { resumeId: 'cv', coverLetter: text } as PreparedApplication);
  assert.throws(() => approved.resolve('other'), /candidate-approved/);
  await assert.rejects(approved.create('Letter.txt', text + 'Changed', 'txt'), /candidate-approved/);
  const exact = await approved.create('Letter.txt', text, 'txt');
  assert.equal(readFileSync(approved.resolve(exact.file_id).path, 'utf8'), text);
  console.log('PASS: native input and file-chooser attachments, original PDF bytes, explicit DOCX/PDF rendering, revised text, agent-owned receipt, owner isolation and exact approved files. No live applications or AI requests.');
  await context.close();
} finally {
  globalThis.fetch = fetchBefore;
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
