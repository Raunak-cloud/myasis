import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { applicationRevision } from './application-review-content.js';
import { isCoverLetterField, cleanCoverLetter } from './cover-letter-policy.js';
export { applicationContent } from './application-review-content.js';
import { readSavedForm } from './agent/saved-form.js';
import type { Locator } from 'patchright';
import { agentOnlyResumePath } from './agent/agent-only-evidence.js';
import { observedApprovedCoverLetter, typedCoverLetterControls } from './application-letter.js';
import type { ToolContext, ToolResult } from './agent/context.js';
import type { JobListing } from './types.js';
import type { PreparedApplication } from './application-review-types.js';
import { applicationFormKey } from './application-identity.js';

export const preparingApplications = () => process.env.APPLICATION_REVIEW_MODE === 'prepare';
export const reviewingApplications = () => preparingApplications() || process.env.APPLICATION_REVIEW_MODE === 'approved';

/** This value is supplied only by the server, never a browser run setting. */
export function approvedApplications(): PreparedApplication[] {
  if (process.env.APPLICATION_REVIEW_MODE !== 'approved') return [];
  const raw = readFileSync(resolve(config.dataDir, 'approved-applications.json'), 'utf8');
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('Invalid approved applications.');
  return value as PreparedApplication[];
}

export function approvedApplication(job: JobListing): PreparedApplication | undefined {
  return approvedApplications().find(item => item.job.id === job.id && (item.job.platform ?? 'seek') === (job.platform ?? 'seek'));
}

/** SEEK binds its review route to a vacancy. Indeed's shared review-module
 * address does not identify a job and must still be reopened from its listing. */
export function approvedSeekReviewUrl(job: JobListing): string | undefined {
  if ((job.platform ?? 'seek') !== 'seek' || job.applicationMode === 'external' || !/^\d{6,12}$/.test(job.id)) return;
  const saved = approvedApplication(job);
  if (!saved || saved.preparation?.stage==='job-and-letter') return;
  try {
    const url = new URL(saved.formUrl);
    if (url.protocol === 'https:' && /^(?:www\.|au\.)?seek\.com(?:\.au)?$/.test(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.pathname === `/job/${job.id}/apply/review`) return url.href;
  } catch { /* An unavailable saved target uses the normal listing flow. */ }
}

const normal = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Preparation records candidate-visible work. Confirmation authorizes this
 * vacancy, not a particular DOM serialization. An approved submission can
 * repair its saved work, but must never create another Prepared application. */
export async function applicationApprovalGate(ctx: ToolContext, _sendControl?: Locator): Promise<ToolResult | null> {
  ctx.formAdvisories = [];
  if (!reviewingApplications()) return null;
  const approved = approvedApplication(ctx.job);
  const form = await readSavedForm(ctx.page);
  if (!preparingApplications() && !approved)
    return { kind: 'ok', disposition: 'failed', message: 'No server-supplied approval exists for this vacancy. Do not submit a different job or create another prepared draft.' };
  if (approved?.documents?.some(document => document.role !== 'cover-letter' && document.requiresUpload && !ctx.uploadedDocuments?.some(file => file.fileId === document.fileId && file.sha256 === document.sha256
    || document.provenance === 'text' && document.text !== undefined && file.coverLetterDigest === createHash('sha256').update(document.text).digest('hex'))))
    return { kind: 'ok', disposition: 'failed', message: 'Upload the exact candidate-revised attachment before sending. Its filename alone does not prove that the new approved bytes replaced the old employer file.' };
  const currentLetterControls = typedCoverLetterControls(form.fields);
  const witnessedLetter = observedApprovedCoverLetter(approved, form.fields, ctx.letterWitness ?? []);
  const actualLetters = [...new Set(currentLetterControls.flatMap(field => field.currentValue === undefined ? [] : [field.currentValue]))];
  if (actualLetters.length > 1) return { kind: 'ok', disposition: 'failed', message: 'The current cover-letter controls contain conflicting values. Inspect the intended saved letter before preparing or sending.' };
  if (actualLetters.length === 1) {
    const attached = ctx.documents?.find(document => document.role === 'cover-letter');
    if (attached && actualLetters[0] && normal(actualLetters[0]) !== normal(attached.text ?? ''))
      return { kind: 'ok', disposition: 'failed', message: 'The current inline letter differs from the bound attachment. Inspect and resolve the actual saved documents before preparing or sending.' };
    if (!attached) ctx.coverLetter = actualLetters[0] || undefined;
  }
  if (ctx.coverLetter === undefined && witnessedLetter !== undefined) ctx.coverLetter = witnessedLetter;
  const originalFileLetter = ctx.documents?.some(document => document.role === 'cover-letter' && document.provenance === 'file' && document.text === ctx.coverLetter);
  if (!originalFileLetter && ctx.coverLetter?.includes('\u2014') || form.fields.some(field => isCoverLetterField(field.label) && field.currentValue?.includes('\u2014'))) {
    ctx.formAdvisories.push('Writing advice: use commas, full stops or parentheses instead of em dashes when authoring a letter. Preserve an already approved document.');
  }
  if (form.fields.some(field => field.validationError || field.invalid === 'true' || field.required && !field.currentValue?.trim())) {
    ctx.formAdvisories.push('The browser reports missing or invalid required fields. Inspect the actual saved controls and employer validation; a DOM hint can describe an inactive or consumed control. Resolve real missing required answers using candidate sources.');
  }
  if (!ctx.resumeName) return { kind: 'ok', disposition: 'failed', message: 'Inspect the selected resume and call prepare_application with its account resume ID, complete answers and cover letter before the final send.' };
  const answers = new Map(ctx.captured.filter(item => !/password|verification.?code|one.?time|\botp\b/i.test(item.question))
    .map(item => [normal(item.question), { question: item.question, answer: isCoverLetterField(item.question)
      && !ctx.documents?.some(document => document.name === item.answer) ? cleanCoverLetter(item.answer) : item.answer }]));
  const observedEmpty = new Set<string>();
  for (const field of form.fields) {
    if (field.sensitive || field.currentValue === undefined) continue;
    if (field.currentValue === '') {
      // File inputs often clear after the employer consumes their FileList;
      // that is not evidence that the saved attachment was removed.
      if (field.inputType !== 'file') { answers.delete(normal(field.label)); observedEmpty.add(normal(field.label)); }
    } else answers.set(normal(field.label), { question: field.label, answer: field.currentValue });
  }
  const resumePath = ctx.resumeUsed ? agentOnlyResumePath(ctx.resumeUsed) : null;
  const resumeHash = resumePath ? createHash('sha256').update(readFileSync(resumePath)).digest('hex') : undefined;
  if (!preparingApplications() && approved) {
    if(!approved.preparation && applicationFormKey(approved.job,approved.formUrl)!==applicationFormKey(ctx.job,form.url))
      return {kind:'ok',disposition:'failed',message:'The saved form belongs to a different vacancy or employer account. Reopen the approved job before sending.'};
    if (approved.resumeId && approved.resumeId !== ctx.resumeUsed || approved.resumeHash && approved.resumeHash !== resumeHash)
      return { kind: 'ok', disposition: 'failed', message: 'Restore the candidate-approved resume and inspect its actual selected bytes before sending. The job remains approved; do not prepare it again.' };
    // Retained answers are joined by their original question. Additional DOM
    // labels (including a selected radio option appended to its question) do
    // not revoke approval. Ordinary string differences are advisory: the
    // applying agent assesses meaning against candidate sources. A conflict is work to
    // repair in place, not an invitation to replace the candidate decision.
    const actual = new Map([...answers.values()].map(item => [normal(item.question), normal(item.answer)]));
    const conflict = approved.answers.find(item => !isCoverLetterField(item.question)
      && (actual.has(normal(item.question)) || observedEmpty.has(normal(item.question)))
      && (actual.get(normal(item.question)) ?? '') !== normal(item.answer));
    if (conflict) ctx.formAdvisories.push(`The displayed answer to "${conflict.question}" differs from the approved text. Compare its meaning with the approved answer and candidate sources; repair a real conflict. A display-label variation does not revoke job approval.`);
    // An approved letter does not require a separate delivery-proof gate.
    // Reject an observed replacement, but leave inclusion to the applying
    // agent and employer validation. Missing evidence is not an upload receipt.
    const typed = currentLetterControls.length ? currentLetterControls : typedCoverLetterControls(ctx.letterWitness ?? []);
    const legacyLetters = [...new Set(approved.answers.filter(answer => typed.some(field => normal(field.label) === normal(answer.question)))
      .map(answer => answer.answer).filter(text => text.trim()))];
    const expectedLetter = approved.coverLetter ?? approved.documents?.find(document => document.role === 'cover-letter')?.text
      ?? (legacyLetters.length === 1 ? legacyLetters[0] : undefined);
    if (expectedLetter && actualLetters.some(text => text.trim() && normal(text) !== normal(expectedLetter)))
      return { kind: 'ok', disposition: 'failed', message: 'Restore the exact approved cover letter in the actual form or attachment before sending. The job remains approved; do not prepare it again.' };
    // New questions use the normal grounded-answer/readiness controls. Unknown
    // consequential facts still require Needs attention. Employer receipts,
    // explicit send intent, document checks and duplicate controls are unchanged.
    return null;
  }
  const draft: PreparedApplication = {
    id: randomUUID(), revision: '', job: ctx.job, formUrl: form.url,
    preparedAt: new Date().toISOString(), answers: [...answers.values()],
    coverLetter: ctx.coverLetter, documents: ctx.documents, resume: ctx.resumeName, resumeId: ctx.resumeUsed,
    resumeHash,
  };
  draft.revision = applicationRevision(draft);
  ctx.log(`  Ready for your confirmation: ${ctx.job.title} @ ${ctx.job.company}`);
  return { kind: 'terminal', outcome: { status: 'prepared', draft } };
}

/** Per-account pending drafts are excluded from future curation until decided. */
export function pendingApplicationKeys(): Set<string> {
  try { return new Set(JSON.parse(readFileSync(resolve(config.dataDir, 'pending-application-keys.json'), 'utf8')) as string[]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
}
