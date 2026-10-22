import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getPool, one, query } from './db/index.js';
import { resolveStored } from './files.js';
import { gmailRequest } from './gmail-connection.js';
import { applicationRevision } from '../../seek-bot/src/application-review-content.js';
import { applicationEmailMessage, applicationEmailMessageId } from '../../seek-bot/src/application-email-message.js';
import { GmailServiceError } from '../../seek-bot/src/gmail-mcp-service.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';
import type { EmailReceipt } from '../../seek-bot/src/gmail-mcp-client.js';
import { gmailAccess } from './gmail-access.js';
import { withGmailBrowser, sendBrowserApplication } from '../../seek-bot/src/gmail-browser.js';

interface SendRow { status: string; message_id: string | null; thread_id: string | null }
async function recordReceipt(userId: string, draft: PreparedApplication, receipt: EmailReceipt): Promise<EmailReceipt> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE application_email_sends SET status='sent',message_id=$4,thread_id=$5,updated_at=now() WHERE user_id=$1 AND review_id=$2 AND revision=$3", [userId, draft.id, draft.revision, receipt.messageId, receipt.threadId || null]);
    await client.query(`INSERT INTO applications(user_id,job_id,title,company,location,url,platform,score,cover_letter,answers,external,submitted_by_myasis,resume_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$9,true,true,$10) ON CONFLICT(user_id,platform,job_id) DO NOTHING`,
    [userId, draft.job.id, draft.job.title, draft.job.company, draft.job.location || '', draft.job.url, draft.job.platform || 'seek', draft.coverLetter, JSON.stringify(draft.answers), draft.resume]);
    await client.query("UPDATE application_reviews SET status='applied',detail='Application email sent.',updated_at=now() WHERE user_id=$1 AND id=$2 AND payload->>'revision'=$3", [userId, draft.id, draft.revision]);
    await client.query('COMMIT'); return receipt;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** The MCP send tool takes an approval identity, never agent-authored mail bytes. */
export async function sendApprovedApplicationEmail(userId: string, reviewId: string, revision: string): Promise<EmailReceipt> {
  const row = await one<{ status: string; payload: PreparedApplication; credit_consumed: boolean }>(
    'SELECT status,payload,credit_consumed FROM application_reviews WHERE user_id=$1 AND id=$2', [userId, reviewId]);
  if (!row || !['approved', 'applied'].includes(row.status) || !row.credit_consumed || !row.payload.email
    || row.payload.revision !== revision || applicationRevision(row.payload) !== revision) throw new GmailServiceError('unapproved', 'Review and confirm this exact email application.');
  const draft = row.payload, connection = await gmailAccess(userId);
  if (!connection.connected || !connection.account) throw new GmailServiceError('reconnect', 'Connect Gmail in Setup.');
  const owner = await one<{ email: string }>('SELECT email FROM profiles WHERE user_id=$1', [userId]);
  if (owner?.email.toLowerCase() !== connection.account.toLowerCase()) throw new GmailServiceError('reconnect', 'Connect the Gmail address in your application profile.');
  const prior = await one<SendRow>('SELECT status,message_id,thread_id FROM application_email_sends WHERE user_id=$1 AND review_id=$2 AND revision=$3', [userId, reviewId, revision]);
  if (prior?.status === 'sent' && prior.message_id) return { messageId: prior.message_id, threadId: prior.thread_id || undefined, alreadySent: true };
  if (row.status !== 'approved') throw new GmailServiceError('unapproved', 'This application is no longer approved.');
  const applied = await one('SELECT id FROM applications WHERE user_id=$1 AND platform=$2 AND job_id=$3 AND submitted_by_myasis=true', [userId, draft.job.platform || 'seek', draft.job.id]);
  if (applied) throw new GmailServiceError('unapproved', 'An application to this role is already recorded. No email was sent.');
  const stored = draft.resumeId ? await resolveStored(userId, 'resume', draft.resumeId) : null;
  if (!stored) throw new GmailServiceError('unapproved', 'The approved resume is unavailable.');
  const resume = readFileSync(stored.path);
  if (!draft.resumeHash || createHash('sha256').update(resume).digest('hex') !== draft.resumeHash) throw new GmailServiceError('unapproved', 'The resume changed. Prepare and confirm this application again.');
  const raw = applicationEmailMessage(draft, connection.account, resume, stored.fileName);
  const jobKey = `${draft.job.platform || 'seek'}:${draft.job.id}`;
  const unresolved = await one(`SELECT status FROM application_email_sends WHERE user_id=$1 AND job_key=$2
    AND (review_id<>$3 OR revision<>$4) AND status IN ('sending','sent','uncertain')`, [userId, jobKey, reviewId, revision]);
  if (unresolved) throw new GmailServiceError('uncertain', 'An earlier email for this job is sent or uncertain. Check Sent before preparing another version.');
  const claimed = await query<SendRow>(`INSERT INTO application_email_sends(user_id,review_id,revision,job_key,status) VALUES($1,$2,$3,$4,'sending')
    ON CONFLICT(user_id,review_id,revision) DO UPDATE SET status='sending',updated_at=now() WHERE application_email_sends.status='failed'
    RETURNING status,message_id,thread_id`, [userId, reviewId, revision, jobKey]).catch(error => {
      if (error?.code === '23505') throw new GmailServiceError('uncertain', 'Another email send for this job is in progress or uncertain.');
      throw error;
    });
  const reconcile = async (): Promise<EmailReceipt | null> => {
    // A browser send without a definite receipt remains blocked for review.
    // Do not infer successful delivery or resend from matching subject text.
    if (connection.provider === 'browser') return null;
    const found = await gmailRequest<{ messages?: Array<{ id: string; threadId: string }> }>(userId, 'messages', {
      params: { q: `in:sent rfc822msgid:${applicationEmailMessageId(reviewId, revision)}`, maxResults: 2 } });
    const message = found.messages?.[0];
    return message?.id ? recordReceipt(userId, draft, { messageId: message.id, threadId: message.threadId, alreadySent: true }) : null;
  };
  if (!claimed.length) {
    const found = await reconcile();
    if (found) return found;
    throw new GmailServiceError('uncertain', 'A prior email send is still uncertain. Check Sent before retrying.');
  }
  try {
    const sent: { id: string; threadId?: string } = connection.provider === 'browser'
      ? await withGmailBrowser(userId, page => sendBrowserApplication(page, draft, connection.account!, resume, stored.fileName))
      : await gmailRequest<{ id: string; threadId?: string }>(userId, 'messages/send', { method: 'POST', data: { raw } });
    if (!sent.id) throw new GmailServiceError('uncertain', 'No email receipt returned.');
    return await recordReceipt(userId, draft, { messageId: sent.id, threadId: sent.threadId });
  } catch (error) {
    const status = (error as { providerStatus?: number }).providerStatus;
    const rejected = error instanceof GmailServiceError && ['reconnect', 'unapproved'].includes(error.code) || status !== undefined && status >= 400 && status < 500;
    await query('UPDATE application_email_sends SET status=$4,updated_at=now() WHERE user_id=$1 AND review_id=$2 AND revision=$3 AND status<>\'sent\'', [userId, reviewId, revision, rejected ? 'failed' : 'uncertain']);
    if (!rejected) {
      const found = await reconcile().catch(() => null); if (found) return found;
      throw new GmailServiceError('uncertain', 'The email send could not be confirmed.');
    }
    throw error;
  }
}
