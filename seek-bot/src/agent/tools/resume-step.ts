import { pickResumeForJob } from '../../resume.js';
import { boardOf, ensureChosenResume, type ResumeStepResult } from '../../resume-sync.js';
import { hostOf } from '../../site-auth.js';
import { ToolContext, ToolResult, noteAction, ok } from './context.js';

/**
 * The resume on a job board's documents step is settled one way only, by
 * resume-sync, whichever tool reaches it. The agent's own upload used to put
 * a second copy of the same file on SEEK beside the one resume-sync uploaded
 * (two copies an application), which is what filled Rinu Thapa's profile to
 * SEEK's limit of ten on 5 Oct.
 */

const boardName = (board: string) => (board === 'seek' ? 'SEEK' : 'Indeed');

/** Records that the board's resume choice is Owtomate's, and what the person should be told. */
export function settleResume(ctx: ToolContext, step: Extract<ResumeStepResult, { name: string }>): void {
  ctx.resumeSettled = true;
  ctx.resumeUsed = step.label;
  ctx.resumeName = step.name;
  const verb = { kept: 'already selected', selected: 'selected', uploaded: 'uploaded from Owtomate and selected' }[step.action];
  ctx.log(`  📄 resume "${step.name}" ${verb} on ${boardName(step.board)}`);
  if (step.action === 'uploaded') {
    noteAction(ctx, { kind: 'resume-uploaded', site: hostOf(ctx.page.url()), detail: `Saved Owtomate's resume "${step.name}" to your ${boardName(step.board)} account and used it for this application.` });
  }
}

/** A board that refused Owtomate's resume for want of room ends the application for the person to free a slot. */
export function boardFullOutcome(step: Extract<ResumeStepResult, { action: 'failed' }>): ToolResult {
  return { kind: 'terminal', outcome: { status: 'needs-human', reason: step.reason, detail: 'board resume limit reached' } };
}

/**
 * For a tool about to upload or pick a resume itself: on a board's documents
 * step, settle it through resume-sync instead. Null when the page is not a
 * board's resume choice, so the tool carries on as for any employer form.
 */
export async function boardResumeInstead(ctx: ToolContext): Promise<ToolResult | null> {
  if (!boardOf(ctx.page.url())) return null;
  if (ctx.resumeSettled) {
    return ok(`The resume for this application is already settled: "${ctx.resumeName ?? ctx.resumeUsed}" is selected. Do not upload or choose another; continue.`);
  }
  const chosen = await pickResumeForJob(ctx.job, ctx.profile);
  if (!chosen) return null;
  const step = await ensureChosenResume(ctx.page, chosen);
  if (step.action === 'none') return null;
  if (step.action === 'failed') {
    if (step.full) return boardFullOutcome(step);
    return ok(`The resume could not be settled: ${step.reason} Re-observe the documents step before trying again; do not delete anything.`);
  }
  settleResume(ctx, step);
  return ok(`Owtomate's resume "${step.name}" is selected on ${boardName(step.board)}. Continue to the next step.`);
}
