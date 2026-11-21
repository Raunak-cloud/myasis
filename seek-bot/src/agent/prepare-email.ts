import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cleanCoverLetter } from '../cover-letter-policy.js';
import { applicationRevision } from '../application-review-content.js';
import { validApplicationEmail } from '../application-email-message.js';
import { gmailAvailable } from '../gmail-mailbox.js';
import { agentOnlyDocuments, agentOnlyResumePath } from './agent-only-evidence.js';
import { readSavedForm } from './saved-form.js';
import { ok, type ToolContext, type ToolResult } from './context.js';
import type { PreparedApplication } from '../application-review-types.js';
import { reviewingApplications, preparingApplications } from '../application-review.js';
import { GmailMcpClient, GmailPreSendError, safeGmailError } from '../gmail-mcp-client.js';
import { config } from '../config.js';
import { applicationAllowance } from '../application-allowance.js';

/** The selected mode applies to email as well as online forms. */
export async function prepareEmailApplication(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (reviewingApplications() && !preparingApplications())
    return ok('This job is already approved. Continue its authorized submission without creating another Prepared draft. Approved email applications use the retained recipient, message and attachments through their existing submission path.', 'failed');
  if (!gmailAvailable()) return ok('Connect Gmail in Setup before preparing an email application. Do not open Gmail in the browser.', 'failed');
  const to = String(args.to || '').trim().toLowerCase(), subject = String(args.subject || '').trim();
  if (!validApplicationEmail(to) || !subject || /[\r\n]/.test(subject) || Buffer.byteLength(subject) > 300) return ok('Supply the employer email address and a subject of up to 300 UTF-8 bytes, without line breaks.', 'failed');
  const form = await readSavedForm(ctx.page);
  const mailtos = await ctx.page.locator('a[href^="mailto:"]').evaluateAll(links => links.map(link => link.getAttribute('href') || '').join('\n'));
  if (!`${form.text}\n${mailtos}`.toLowerCase().includes(to)) return ok('The recipient must appear in the employer application instructions on the current page. Open those instructions and inspect the address.', 'failed');
  const letter = cleanCoverLetter(String(args.cover_letter || ''));
  const document = agentOnlyDocuments().find(item => item.id === args.resume_id);
  const path = document ? agentOnlyResumePath(document.id) : null;
  if (!letter || !document || !path) return ok('Supply the complete cover letter and a resume ID from this candidate account.', 'failed');
  const draft: PreparedApplication = { id: randomUUID(), revision: '', job: { ...ctx.job, applicationMode: 'external' },
    preparedAt: new Date().toISOString(), formUrl: form.url, answers: [], coverLetter: letter,
    resume: document.fileName, resumeId: document.id, resumeHash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    email: { to, subject, attachCoverLetter: args.attach_cover_letter === true } };
  draft.revision = applicationRevision(draft);
  if (!preparingApplications()) {
    if (config.dryRun) return { kind: 'terminal', outcome: { status: 'rehearsed', stoppedAt: 'Email inspected; dry-run never sends.' } };
    if (!await applicationAllowance(true)) return { kind: 'terminal', outcome: { status: 'skipped', reason: 'The account application allowance has been reached.' } };
    const client = new GmailMcpClient({url: process.env.GMAIL_MCP_URL!, token: process.env.GMAIL_MCP_TOKEN!, account: process.env.GMAIL_MCP_ACCOUNT!});
    ctx.coverLetter = letter; ctx.resumeUsed = document.id; ctx.resumeName = document.fileName;
    const previouslyAttempted = Boolean(ctx.submissionAttempted);
    ctx.submissionAttempted = true;
    try {
      const receipt = await client.sendAutomatic(draft);
      ctx.log(`  Gmail confirmed the Auto application email${receipt.alreadySent ? ' (already sent; no duplicate)' : ''}.`);
      return { kind: 'terminal', outcome: { status: 'applied', prepaid: true } };
    } catch (error) {
      if (error instanceof GmailPreSendError && !previouslyAttempted) {
        ctx.submissionAttempted = false;
        return ok(JSON.stringify({
          status: 'failed-before-send', sendAttempted: false, reason: error.message,
          recovery: 'Use this evidence to decide whether to retry the exact same email or finish with the blocker. A retry opens a fresh Gmail compose. Preserve the recipient, message and documents. Stop if the same failure repeats without progress.',
        }), 'failed');
      }
      return { kind: 'terminal', outcome: { status: 'error', reason: safeGmailError(error).message, retryable: false } };
    } finally { await client.close(); }
  }
  ctx.log(`  Email application ready for your confirmation: ${ctx.job.title} @ ${ctx.job.company}`);
  return { kind: 'terminal', outcome: { status: 'prepared', draft } };
}
