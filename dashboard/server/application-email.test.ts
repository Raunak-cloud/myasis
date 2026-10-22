import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPool } from './db/index.js';
import { userDir, USERS_DIR } from './userdata.js';
import { sendApprovedApplicationEmail } from './application-email.js';
import { encryptGmailToken } from './gmail-connection.js';
import { applicationRevision } from '../../seek-bot/src/application-review-content.js';
import { applicationEmailMessageId } from '../../seek-bot/src/application-email-message.js';
import { OAuth2Client, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from '../../seek-bot/src/gmail-mcp-client.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';
const pool = getPool();
after(async () => { await pool.end(); });

test('production email backend validates exact approvals and attachments; uncertain sends reconcile or remain blocked without resending', async () => {
  const owner = `gmail-mcp-fixture-${process.pid}`, directory = userDir(owner);
  const resume = Buffer.from('Exact fixture resume bytes');
  assert.equal(resolve(directory).startsWith(resolve(USERS_DIR) + (process.platform === 'win32' ? '\\' : '/')), true);
  mkdirSync(join(directory, 'resumes'), { recursive: true }); writeFileSync(join(directory, 'resumes', 'CV.txt'), resume);
  const originals = { query: pool.query, connect: pool.connect, request: OAuth2Client.prototype.request, key: process.env.GMAIL_TOKEN_ENCRYPTION_KEY, public: process.env.GMAIL_MCP_PUBLIC_ENABLED };
  process.env.GMAIL_MCP_PUBLIC_ENABLED = 'true';
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = 'fixture-only-encryption-key';
  const encrypted = encryptGmailToken(owner, 'private-fixture-refresh');
  const reviews = new Map<string, { status: string; payload: PreparedApplication; credit_consumed: boolean }>();
  const outbox = new Map<string, { status: string; message_id?: string; thread_id?: string }>();
  const outboxJobs = new Map<string, string>();
  const applied = new Set<string>(), delivered = new Map<string, { id: string; threadId: string }>();
  let attempts = 0, mode: 'success' | 'uncertain-sent' | 'uncertain-unsent' | 'rejected' = 'success';
  const sql = async (statement: string, params: any[] = []) => {
    if (statement.startsWith('SELECT u.email,p.email')) return { rows: [{ email: 'candidate@fixture.invalid', profile_email: 'candidate@fixture.invalid' }] };
    if (statement.startsWith('SELECT key,value FROM settings')) return { rows: [] };
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [] };
    if (statement.includes('FROM application_reviews')) return { rows: params[0] === owner && reviews.has(params[1]) ? [reviews.get(params[1])] : [] };
    if (statement.startsWith('SELECT gmail_email')) return { rows: [{ current: true, same_address: true, gmail_email: 'candidate@fixture.invalid', scope: `${GMAIL_READ_SCOPE} ${GMAIL_SEND_SCOPE}`, last_error: null }] };
    if (statement.includes('FROM google_connections g JOIN users')) { assert.equal(params[0], owner); return { rows: [{ refresh_token: encrypted, scope: `${GMAIL_READ_SCOPE} ${GMAIL_SEND_SCOPE}` }] }; }
    if (statement.startsWith('SELECT email FROM profiles')) return { rows: [{ email: 'candidate@fixture.invalid' }] };
    if (statement.includes('FROM resumes WHERE user_id')) return { rows: [{ id: 'cv', label: 'Fixture CV', file_name: 'CV.txt', uploaded_at: new Date(), size_bytes: resume.length }] };
    if (statement.startsWith('SELECT id FROM applications')) return { rows: applied.has(params[2]) ? [{ id: 1 }] : [] };
    if (statement.startsWith('SELECT status FROM application_email_sends')) return { rows: [...outbox.entries()].filter(([key, row]) => outboxJobs.get(key) === params[1]
      && key !== `${params[2]}:${params[3]}` && ['sending', 'sent', 'uncertain'].includes(row.status)).map(([, row]) => row) };
    const key = `${params[1]}:${params[2]}`;
    if (statement.startsWith('SELECT status,message_id')) return { rows: outbox.has(key) ? [outbox.get(key)] : [] };
    if (statement.startsWith('INSERT INTO application_email_sends')) {
      if (outbox.has(key) && outbox.get(key)!.status !== 'failed') return { rows: [] };
      outbox.set(key, { status: 'sending' }); outboxJobs.set(key, params[3]); return { rows: [outbox.get(key)] };
    }
    if (statement.startsWith("UPDATE application_email_sends SET status='sent'")) {
      outbox.set(key, { status: 'sent', message_id: params[3], thread_id: params[4] }); return { rows: [] };
    }
    if (statement.startsWith('UPDATE application_email_sends SET status=$4')) { outbox.get(key)!.status = params[3]; return { rows: [] }; }
    if (statement.startsWith('INSERT INTO applications')) { applied.add(params[1]); return { rows: [] }; }
    if (statement.startsWith("UPDATE application_reviews SET status='applied'")) { reviews.get(params[1])!.status = 'applied'; return { rows: [] }; }
    if (statement.startsWith('UPDATE google_connections SET last_error')) return { rows: [] };
    throw new Error(`Unexpected fixture SQL: ${statement}`);
  };
  pool.query = sql as unknown as typeof originals.query;
  pool.connect = (async () => ({ query: sql, release() {} })) as unknown as typeof originals.connect;
  OAuth2Client.prototype.request = (async (request: { url: string; data?: { raw: string }; params?: { q: string } }) => {
    assert.ok(request.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/'));
    if (request.url.endsWith('/messages/send')) {
      attempts++;
      const mime = Buffer.from(request.data!.raw, 'base64url').toString('utf8');
      const messageId = /Message-ID: (.+)\r\n/.exec(mime)![1];
      assert.match(mime, /To: <careers@fixture.invalid>/); assert.doesNotMatch(mime, /Bcc:/);
      assert.ok(mime.includes(resume.toString('base64')));
      if (mode === 'rejected') throw Object.assign(new Error('private provider details'), { response: { status: 403 } });
      const response = { id: `fixture-${attempts}`, threadId: `thread-${attempts}` };
      if (mode !== 'uncertain-unsent') delivered.set(messageId, response);
      if (mode.startsWith('uncertain')) throw new Error('network disconnected after request');
      return { data: response };
    }
    if (request.url.endsWith('/messages')) {
      const key = request.params!.q.replace('in:sent rfc822msgid:', '');
      return { data: { messages: delivered.has(key) ? [delivered.get(key)] : [] } };
    }
    throw new Error('No non-fixture Google endpoint may be called');
  }) as unknown as typeof originals.request;
  const create = () => {
    const draft: PreparedApplication = { id: randomUUID(), revision: '', job: { id: randomUUID(), platform: 'indeed', title: 'Developer', company: 'Fixture', location: 'Sydney', url: 'https://jobs.fixture.invalid/developer' },
      formUrl: 'https://jobs.fixture.invalid/developer', preparedAt: new Date().toISOString(), answers: [], coverLetter: 'The exact approved letter.', resumeId: 'cv', resume: 'CV.txt',
      resumeHash: createHash('sha256').update(resume).digest('hex'), email: { to: 'careers@fixture.invalid', subject: 'Developer application', attachCoverLetter: true } };
    draft.revision = applicationRevision(draft); reviews.set(draft.id, { status: 'approved', payload: draft, credit_consumed: true }); return draft;
  };
  try {
    const ordinary = create();
    await assert.rejects(sendApprovedApplicationEmail('foreign-owner', ordinary.id, ordinary.revision), /confirm this exact/);
    await assert.rejects(sendApprovedApplicationEmail(owner, ordinary.id, '0'.repeat(64)), /confirm this exact/);
    reviews.get(ordinary.id)!.status = 'ready'; await assert.rejects(sendApprovedApplicationEmail(owner, ordinary.id, ordinary.revision), /confirm this exact/);
    reviews.get(ordinary.id)!.status = 'approved';
    assert.equal(attempts, 0);
    const sent = await sendApprovedApplicationEmail(owner, ordinary.id, ordinary.revision);
    assert.equal(sent.messageId, 'fixture-1'); assert.equal(attempts, 1); assert.ok(applied.has(ordinary.job.id));
    assert.equal((await sendApprovedApplicationEmail(owner, ordinary.id, ordinary.revision)).alreadySent, true); assert.equal(attempts, 1);
    const changed = create(); writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Different resume');
    await assert.rejects(sendApprovedApplicationEmail(owner, changed.id, changed.revision), /resume changed/); assert.equal(attempts, 1);
    writeFileSync(join(directory, 'resumes', 'CV.txt'), resume);
    const lost = create(); mode = 'uncertain-sent';
    const recovered = await sendApprovedApplicationEmail(owner, lost.id, lost.revision);
    assert.equal(recovered.alreadySent, true); assert.ok(delivered.has(applicationEmailMessageId(lost.id, lost.revision)));
    assert.equal(attempts, 2);
    const uncertain = create(); mode = 'uncertain-unsent';
    await assert.rejects(sendApprovedApplicationEmail(owner, uncertain.id, uncertain.revision), /could not be confirmed/);
    await assert.rejects(sendApprovedApplicationEmail(owner, uncertain.id, uncertain.revision), /prior email send/);
    assert.equal(attempts, 3, 'an uncertain result never automatically resends');
    uncertain.coverLetter = 'A different edited letter'; uncertain.revision = applicationRevision(uncertain);
    await assert.rejects(sendApprovedApplicationEmail(owner, uncertain.id, uncertain.revision), /earlier email/);
    assert.equal(attempts, 3, 'editing content cannot bypass an uncertain earlier send');
    const refused = create(); mode = 'rejected';
    await assert.rejects(sendApprovedApplicationEmail(owner, refused.id, refused.revision), /request could not/);
    assert.equal(outbox.get(`${refused.id}:${refused.revision}`)!.status, 'failed');
    mode = 'success'; await sendApprovedApplicationEmail(owner, refused.id, refused.revision); assert.equal(attempts, 5);
    assert.equal(readFileSync(join(directory, 'resumes', 'CV.txt')).equals(resume), true);
  } finally {
    pool.query = originals.query; pool.connect = originals.connect; OAuth2Client.prototype.request = originals.request;
    if (originals.key === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY; else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = originals.key;
    if (originals.public === undefined) delete process.env.GMAIL_MCP_PUBLIC_ENABLED; else process.env.GMAIL_MCP_PUBLIC_ENABLED = originals.public;
    rmSync(directory, { recursive: true, force: true });
  }
});
