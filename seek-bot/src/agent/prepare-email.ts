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

/** Email applications always wait for candidate confirmation, including Auto runs. */
export async function prepareEmailApplication(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
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
  ctx.log(`  Email application ready for your confirmation: ${ctx.job.title} @ ${ctx.job.company}`);
  return { kind: 'terminal', outcome: { status: 'prepared', draft } };
}
