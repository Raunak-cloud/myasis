import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { GmailMcpService, GmailServiceError } from '../gmail-mcp-service.js';
import { withApplicationModel } from '../application-model.js';
import { applicationRevision } from '../application-review-content.js';
import { applicationEmailMessage } from '../application-email-message.js';
import type { ToolContext } from './context.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-auto-email-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false', APPLICATION_REVIEW_MODE: '', DRY_RUN: 'false' });
mkdirSync(join(directory, 'resumes'));
const bytes = Buffer.from('Synthetic selected resume');
writeFileSync(join(directory, 'resumes', 'CV.txt'), bytes);
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', fileName: 'CV.txt', label: 'Selected CV' }]));
const { prepareEmailApplication } = await import('./prepare-email.js');
const { config } = await import('../config.js');
const { withApplicationAllowance } = await import('../application-allowance.js');
const { runAgentOnlyApplication } = await import('./agent-only.js');
const { outcomeFromRun } = await import('./outcome.js');
config.dryRun = false;
const deliveries = new Map<string, string>(); let requests = 0, uncertain = false;
let beforeSendFailure = false;
let failedRevision: string | undefined;
const service = new GmailMcpService({ search: async () => [], thread: async () => [], send: async () => { throw Error('No manual approval exists'); },
  sendAutomatic: async (owner, run, draft) => {
    assert.equal(owner, 'owner'); assert.equal(run, '1378'); requests++;
    assert.equal(applicationRevision(draft), draft.revision);
    assert.equal(draft.job.fitReview, undefined, 'review provenance is not needed in the email gateway');
    const mime = Buffer.from(applicationEmailMessage(draft, 'candidate@fixture.invalid', bytes, 'CV.txt'), 'base64url').toString('utf8');
    assert.match(mime, /To: <careers@fixture.invalid>/);
    assert.ok(mime.includes(bytes.toString('base64')));
    assert.ok(mime.replaceAll('\r\n','').includes(Buffer.from(draft.coverLetter!).toString('base64')));
    if (uncertain) throw new GmailServiceError('uncertain', 'No confirmed receipt');
    if (beforeSendFailure) {
      beforeSendFailure = false;
      failedRevision = draft.revision;
      throw new GmailServiceError('pre-send', 'Gmail stopped before Send at waiting-for-attachments. Resume listed, one upload indicator visible.');
    }
    const key = draft.job.id + ':' + draft.revision;
    if (deliveries.has(key)) return { messageId: deliveries.get(key)!, alreadySent: true };
    deliveries.set(key, `receipt-${deliveries.size}`); return { messageId: deliveries.get(key)! };
  } });
const automatic = await service.grant('owner', 'candidate@fixture.invalid', [], '1378');
const readOnly = await service.grant('owner', 'candidate@fixture.invalid');
Object.assign(process.env, { GMAIL_MCP_URL: automatic.connection.url, GMAIL_MCP_TOKEN: automatic.connection.token, GMAIL_MCP_ACCOUNT: automatic.connection.account });
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({contentType:'text/html',body:'<main>Apply by email to careers@fixture.invalid with your resume and cover letter.</main>'}));
  await page.goto('https://employer.fixture.invalid/job');
  const context = (id: string) => ({ page, job: { id, title:'Developer', company:'Fixture', location:'Sydney', url:page.url(), platform:'jora' }, captured:[], actions:[], log:()=>{} } as unknown as ToolContext);
  const args = {to:'careers@fixture.invalid',subject:'Developer application',cover_letter:'Dear team,\n\nI build software. Please find my selected resume attached.\n\nCandidate',resume_id:'cv',attach_cover_letter:true};
  let ctx = context('auto');
  const sent = await prepareEmailApplication(ctx, args);
  assert.equal(sent.kind, 'terminal'); if (sent.kind !== 'terminal') throw Error('Missing outcome');
  assert.equal(sent.outcome.status, 'applied');
  assert.ok(sent.outcome.status === 'applied' && sent.outcome.prepaid);
  assert.equal(ctx.submissionAttempted, true); assert.equal(ctx.resumeUsed, 'cv');
  assert.equal(deliveries.size, 1);
  await prepareEmailApplication(context('auto'), args);
  assert.equal(deliveries.size, 1, 'replaying identical content does not send another email');
  process.env.APPLICATION_REVIEW_MODE = 'prepare';
  const before = requests;
  const prepared = await prepareEmailApplication(context('semi-auto'), args);
  assert.ok(prepared.kind === 'terminal' && prepared.outcome.status === 'prepared');
  assert.equal(requests, before, 'Semi auto never transmits an application');
  if (prepared.kind === 'terminal' && prepared.outcome.status === 'prepared') assert.equal(applicationRevision(prepared.outcome.draft), prepared.outcome.draft.revision);
  process.env.APPLICATION_REVIEW_MODE = '';
  config.dryRun = true;
  assert.ok((await prepareEmailApplication(context('dry'), args)).kind === 'terminal');
  assert.equal(requests, before, 'dry runs do not send'); config.dryRun = false;
  const capped = await withApplicationAllowance(() => false, () => prepareEmailApplication(context('cap'), args));
  assert.ok(capped.kind === 'terminal' && capped.outcome.status === 'skipped'); assert.equal(requests, before);
  process.env.GMAIL_MCP_TOKEN = readOnly.connection.token;
  const unauthorized = await prepareEmailApplication(context('read-only'), args);
  assert.ok(unauthorized.kind === 'terminal' && unauthorized.outcome.status === 'error'); assert.equal(requests, before, 'read-only leases cannot turn themselves into Auto permission');
  process.env.GMAIL_MCP_TOKEN = automatic.connection.token; uncertain = true;
  const uncertainContext = context('uncertain');
  const missingReceipt = await prepareEmailApplication(uncertainContext, args);
  assert.ok(missingReceipt.kind === 'terminal' && missingReceipt.outcome.status === 'error');
  assert.equal(uncertainContext.submissionAttempted, true, 'a lost receipt never becomes permission to repeat a send');
  assert.equal(requests, before + 1, 'an uncertain send stops instead of preparing or sending again');
  const forged = await prepareEmailApplication(context('wrong-recipient'), {...args,to:'other@fixture.invalid'});
  assert.ok(forged.kind === 'ok' && forged.disposition === 'failed'); assert.equal(requests, before + 1);
  uncertain = false; config.allowExternalApply = true;
  beforeSendFailure = true;
  const retryContext = context('pre-send');
  const recoverable = await prepareEmailApplication(retryContext, args);
  assert.ok(recoverable.kind === 'ok' && recoverable.disposition === 'failed');
  assert.match(recoverable.message, /"sendAttempted":false.*waiting-for-attachments/);
  assert.equal(retryContext.submissionAttempted, false);
  const originalFetch = globalThis.fetch;
  try {
    for (const model of ['celeris', 'minimax']) {
      beforeSendFailure = true;
      const requestsBeforeRecovery = requests;
      let modelTurns = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, init);
        if (++modelTurns === 2) assert.match(String(init?.body), /failed-before-send.*waiting-for-attachments/);
        return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`auto-fixture-${modelTurns}`,type:'function',function:{name:'prepare_email_application',arguments:JSON.stringify(args)}}]}}]});
      };
      const job = {id:`agent-auto-${model}`,title:'Developer',company:'Fixture',location:'Sydney',url:page.url()};
      const run = await withApplicationModel({ ...process.env, APPLICATION_AI_MODEL: model, OPENROUTER_API_KEY: 'fixture-only' },
        () => runAgentOnlyApplication({page,job,profile:{name:'Fixture Candidate',email:'candidate@fixture.invalid',skills:[]} as never,log:()=>{}}));
      assert.equal(run.outcome.status,'applied');assert.equal(run.submitPressed,true);
      const outcome = outcomeFromRun(run,job.id,page.url());
      assert.equal(outcome.status,'applied');assert.equal(outcome.prepaid,true);
      assert.equal(outcome.resume,'CV.txt');assert.equal(outcome.coverLetter,args.cover_letter);
      assert.equal(requests, requestsBeforeRecovery + 2, 'the agent receives a fresh turn and chooses to retry the same draft');
      assert.ok(deliveries.has(`${job.id}:${failedRevision}`), 'recovery retains the exact draft revision');
    }
  } finally { globalThis.fetch=originalFetch; }
  console.log('PASS: Auto email sends selected resume/letter through real MCP and records a receipt; Semi auto prepares only; duplicates, missing receipts, read-only leases, dry runs, allowance and recipient boundaries preserved.');
} finally { await browser.close(); automatic.revoke(); readOnly.revoke(); await service.close(); rmSync(directory,{recursive:true,force:true}); }
