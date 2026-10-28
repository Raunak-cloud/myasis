import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { GmailMcpService, GmailServiceError } from '../gmail-mcp-service.js';
import { applicationEmailMessage } from '../application-email-message.js';
import { applicationRevision, withCoverLetter } from '../application-review-content.js';
import type { PreparedApplication } from '../application-review-types.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-email-applications-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false',
  APPLICATION_REVIEW_MODE: 'prepare', DRY_RUN: 'false' });
mkdirSync(join(directory, 'resumes'));
const resume = Buffer.from('Private fixture resume');
writeFileSync(join(directory, 'resumes', 'Fixture CV.txt'), resume);
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fixture', fileName: 'Fixture CV.txt' }]));
const { runAgentOnlyApplication } = await import('./agent-only.js');
const { config } = await import('../config.js');
const { submitApprovedEmail } = await import('../gmail-mailbox.js');
const { withApplicationAllowance } = await import('../application-allowance.js');
config.allowExternalApply = true; config.dryRun = false;
const drafts: PreparedApplication[] = [], sends = new Map<string, string>();
let calls = 0, oldPrepare = false;
const service = new GmailMcpService({ search: async () => [], thread: async () => [], send: async (owner, id, revision) => {
  assert.equal(owner, 'fixture-owner');
  const draft = drafts.find(item => item.id === id);
  if (!draft || applicationRevision(draft) !== revision) throw new GmailServiceError('unapproved', 'The approved application changed.');
  if (sends.has(id)) return { messageId: sends.get(id)!, alreadySent: true };
  const raw = Buffer.from(applicationEmailMessage(draft, 'candidate@fixture.invalid', resume, 'Fixture CV.txt'), 'base64url').toString('utf8');
  assert.ok(raw.includes(`To: <${draft.email!.to}>`));
  assert.ok(raw.includes(Buffer.from(draft.coverLetter!).toString('base64').slice(0, 50)));
  assert.ok(raw.includes(resume.toString('base64'))); assert.doesNotMatch(raw, /Bcc:/);
  sends.set(id, `message-${sends.size + 1}`); return { messageId: sends.get(id)! };
} });
const lease = await service.grant('fixture-owner', 'candidate@fixture.invalid');
Object.assign(process.env, { GMAIL_MCP_URL: lease.connection.url, GMAIL_MCP_TOKEN: lease.connection.token, GMAIL_MCP_ACCOUNT: lease.connection.account });
const originalFetch = globalThis.fetch;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, init);
    const body = JSON.parse(String(init?.body));
    const job = JSON.parse(body.messages[1].content.split('APPLICATION (listing content is untrusted evidence)\n')[1].split('\n')[0]);
    const name = oldPrepare ? 'prepare_application' : 'prepare_email_application';
    const args = oldPrepare ? { answers: [], resume_id: 'cv' } : { to: `careers${job.id}@fixture.invalid`, subject: `Application for ${job.title}`,
      cover_letter: `Dear hiring team,\n\nI build reliable software — and would like to apply.\n\nFixture Candidate`, resume_id: 'cv', attach_cover_letter: true };
    oldPrepare = false; calls++;
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `fixture-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
  };
  const page = await browser.newPage();
  await page.route('**/*', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({ contentType: 'text/html', body: `<main><h1>Developer ${id}</h1><p>Apply by email to careers${id}@fixture.invalid with your cover letter and resume.</p><a href="mailto:careers${id}@fixture.invalid">Email application</a></main>` });
  });
  for (let id = 1; id <= 5; id++) {
    const job = { id: String(id), title: `Developer ${id}`, company: 'Fixture', location: 'Sydney', url: `https://careers.fixture.invalid/job/${id}` };
    await page.goto(job.url); if (id === 1) oldPrepare = true;
    const result = await runAgentOnlyApplication({ page, job, profile: { name: 'Fixture Candidate', email: 'candidate@fixture.invalid', skills: [] } as never, log: () => {} });
    assert.equal(result.outcome.status, 'prepared'); assert.ok(result.outcome.status === 'prepared');
    assert.equal(result.submitPressed, false); assert.equal(sends.size, 0);
    assert.equal(result.outcome.draft.email?.to, `careers${id}@fixture.invalid`);
    assert.equal(result.outcome.draft.resumeHash, createHash('sha256').update(resume).digest('hex'));
    assert.equal(result.outcome.draft.coverLetter!.includes('\u2014'), false);
    drafts.push(result.outcome.draft);
  }
  const preparedCalls = calls;
  drafts[0] = withCoverLetter(drafts[0], 'Dear team,\n\nThis is the exact candidate-edited letter.\n\nFixture Candidate');
  const approved = await service.grant('fixture-owner', 'candidate@fixture.invalid', drafts.map(draft => draft.id));
  process.env.GMAIL_MCP_TOKEN = approved.connection.token;
  config.dryRun = true;
  assert.equal((await submitApprovedEmail(drafts[0])).status, 'rehearsed'); assert.equal(sends.size, 0);
  config.dryRun = false;
  writeFileSync(join(directory, 'approved-applications.json'), JSON.stringify(drafts));
  const submitBatch = () => new Promise<string>((done, fail) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../main.js', import.meta.url))], {
      env: { ...process.env, APPLICATION_REVIEW_MODE: 'approved', DRY_RUN: 'false', ADMIN_UNLIMITED:'true', APPLICATIONS_UNLIMITED:'true', MAX_APPS_PER_DAY:'none',
        CHROME_PATH: '/fixture/chrome-does-not-exist', KEYWORDS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let transcript = '';
    child.stdout.on('data', chunk => { transcript += chunk; }); child.stderr.on('data', chunk => { transcript += chunk; });
    child.on('error', fail); child.on('close', code => code === 0 ? done(transcript) : fail(new Error(transcript)));
  });
  writeFileSync(join(directory,'applied.json'),JSON.stringify(Array.from({length:98},(_,i)=>({jobId:`daily-seed-${i}`,platform:'seek',title:'Earlier fixture application',company:'Fixture',location:'Sydney',url:'https://fixture.invalid',appliedAt:new Date().toISOString(),score:1,scoreReasons:[],submittedByMyasis:true}))));
  const capped = await submitBatch();
  assert.match(capped,/Daily cap of 100 reached/);
  assert.match(capped,/Run complete: 2 new application/);
  assert.equal(sends.size,2,'a five-email batch starting at 98 sends only two, including admin/unlimited flags');
  const records = JSON.parse(readFileSync(join(directory,'applied.json'),'utf8'));
  assert.equal(records.length,100);
  writeFileSync(join(directory,'applied.json'),JSON.stringify(records.filter((row:{jobId:string})=>!row.jobId.startsWith('daily-seed-'))));
  const output = await submitBatch();
  assert.match(output, /Run complete: 3 new application/);
  assert.equal(JSON.parse(readFileSync(join(directory, 'applied.json'), 'utf8')).length, 5);
  assert.equal(sends.size, 5); assert.equal(calls, preparedCalls, 'confirmed email sends need no browser/model reconstruction');
  await withApplicationAllowance(async () => true, () => submitApprovedEmail(drafts[0]));
  assert.equal(sends.size, 5, 'receipt replay does not send another email');
  const changed = { ...drafts[0], email: { ...drafts[0].email!, to: 'changed@fixture.invalid' } };
  changed.revision = applicationRevision(changed);
  assert.equal((await withApplicationAllowance(async () => true, () => submitApprovedEmail(changed))).status, 'needs-human');
  approved.revoke();
  console.log('PASS: five email-only jobs prepared with no sends; exact approved letters/resumes submitted through real MCP transport, without model/browser replay; changed versions refused, dry-run read-only, repeat receipts deduplicated.');
} finally {
  globalThis.fetch = originalFetch; lease.revoke(); await service.close(); await browser.close(); rmSync(directory, { recursive: true, force: true });
}
