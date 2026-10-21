import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { applicationKeys, applicationFormKey } from './application-identity.js';
import { readSavedForm } from './agent/saved-form.js';
import { agentOnlyResumePath } from './agent/agent-only-evidence.js';
import type { ToolContext, ToolResult } from './agent/tools/context.js';
import type { JobListing } from './types.js';
import type { PreparedApplication } from './application-review-types.js';

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

const normal = (text: string) => text.replace(/\s+/g, ' ').trim();
export function applicationContent(application: Pick<PreparedApplication, 'job' | 'formUrl' | 'answers' | 'coverLetter' | 'resumeHash' | 'resume'>): string {
  const answers = application.answers.map(item => [normal(item.question), normal(item.answer)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const posting = Object.fromEntries(['title', 'company', 'location', 'description', 'salary'].map(key => [key, normal(String(application.job[key as keyof JobListing] ?? ''))]));
  return JSON.stringify({ target: applicationKeys(application.job), posting, form: applicationFormKey(application.job, application.formUrl), answers, coverLetter: normal(application.coverLetter ?? ''), resume: application.resume ?? '', resumeHash: application.resumeHash ?? '' });
}

/** Persist the exact candidate-visible answers, rather than a browser session
 * that may expire while its owner is deciding. Reopening may require filling
 * again; a changed application returns to review instead of inheriting consent. */
export async function applicationApprovalGate(ctx: ToolContext): Promise<ToolResult | null> {
  if (!reviewingApplications()) return null;
  const form = await readSavedForm(ctx.page);
  if (form.fields.some(field => field.validationError || field.invalid === 'true' || field.required && !field.currentValue?.trim())) {
    return { kind: 'ok', disposition: 'failed', message: 'The form still has missing or invalid required fields. Complete and inspect them before saving it for confirmation.' };
  }
  if (!ctx.resumeName) return { kind: 'ok', disposition: 'failed', message: 'Inspect the selected resume and call prepare_application with its account resume ID, complete answers and cover letter before the final send.' };
  const answers = new Map(ctx.captured.filter(item => !/password|verification.?code|one.?time|\botp\b/i.test(item.question))
    .map(item => [normal(item.question), { question: item.question, answer: item.answer }]));
  for (const field of form.fields) {
    if (field.currentValue !== undefined && field.currentValue !== '' && !field.sensitive) {
      answers.set(normal(field.label), { question: field.label, answer: field.currentValue });
    }
  }
  const resumePath = ctx.resumeUsed ? agentOnlyResumePath(ctx.resumeUsed) : null;
  const draft: PreparedApplication = {
    id: randomUUID(), revision: '', job: ctx.job, formUrl: form.url,
    preparedAt: new Date().toISOString(), answers: [...answers.values()],
    coverLetter: ctx.coverLetter, resume: ctx.resumeName, resumeId: ctx.resumeUsed,
    resumeHash: resumePath ? createHash('sha256').update(readFileSync(resumePath)).digest('hex') : undefined,
  };
  draft.revision = createHash('sha256').update(applicationContent(draft)).digest('hex');
  const approved = approvedApplication(ctx.job);
  if (!preparingApplications() && approved?.revision === draft.revision) return null;
  ctx.log(`  Ready for your confirmation: ${ctx.job.title} @ ${ctx.job.company}${approved ? ' (the application changed)' : ''}`);
  return { kind: 'terminal', outcome: { status: 'prepared', draft } };
}

/** Per-account pending drafts are excluded from future curation until decided. */
export function pendingApplicationKeys(): Set<string> {
  try { return new Set(JSON.parse(readFileSync(resolve(config.dataDir, 'pending-application-keys.json'), 'utf8')) as string[]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
}
