import { verifyAlreadyApplied, verifySubmissionEvidence } from '../../llm.js';
import { isExternal } from '../guards.js';
import { handleCaptchaWithCapMonster } from '../../captcha.js';
import { ToolResult, ToolContext, ok } from './context.js';
import { submissionEvidence } from './gate.js';

// Part of the agent's tools, split from tools.ts by concern; tools.ts re-exports it.

export async function doFinish(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const reason = String(args.reason ?? 'no reason given');
  /**
   * CAPTCHAs belong to CapMonster, never to the model's judgment. A widget
   * that loads only when scrolled into view is invisible to the check that
   * runs before every tool, so the agent once gave up on a plain "I'm not a
   * robot" box nobody had tried. Bring every lazy widget into view and let
   * the solver have its turn before any give-up over one is accepted.
   */
  if (/captcha|robot|security verification|verify (?:that )?you(?:'| a)re human|bot check/i.test(reason) && ['cannot_complete', 'needs_human'].includes(String(args.status))) {
    await ctx.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await ctx.page.waitForTimeout(2_500).catch(() => {});
    const captcha = await handleCaptchaWithCapMonster(ctx.page);
    if (captcha === 'solved') return ok('CapMonster cleared the verification. Re-observe the page and continue the application.');
    if (captcha === 'none') ctx.log('  · the agent reported a CAPTCHA, but none is on the page');
  }
  switch (String(args.status)) {
    case 'submitted':
      /**
       * The model does not get to declare success. Only `detectConfirmation`
       * does, and the loop checks it before every turn — so if we are here,
       * the page never showed a confirmation, so this attempt is skipped.
       */
      return {
        kind: 'terminal',
        outcome: {
          status: 'skipped',
          reason: 'The application was not confirmed as submitted.',
        },
      };
    case 'off_platform':
      /**
       * "Continues elsewhere" is a claim about where the page is, and the
       * URL settles it. Indeed's wizard has thrown an application back to
       * the Indeed homepage mid-flow; that is the board closing the form,
       * not the employer taking over, and it belongs in Needs attention.
       */
      if (!isExternal(ctx.page.url())) {
        return {
          kind: 'terminal',
          outcome: { status: 'needs-human', reason: 'The job board closed the application form before it was finished.' },
        };
      }
      return { kind: 'terminal', outcome: { status: 'off-platform', redirectedTo: ctx.page.url() } };
    case 'already_applied': {
      /**
       * "You have already applied" right after this attempt pressed submit is
       * usually this attempt's own success, shown on a status page instead of
       * a thank-you page. Recording it as a prior application loses a real
       * submission from the candidate's list, so the same independent check
       * that backs confirm_submission decides.
       */
      if (ctx.submissionAttempted) {
        const evidence = await submissionEvidence(ctx);
        if (await verifySubmissionEvidence(evidence, ctx.job).catch(() => false)) {
          return { kind: 'terminal', outcome: { status: 'applied' } };
        }
      }
      // An independent read of the page decides, as for a confirmation: "applied here before" is not this job.
      const prior = await verifyAlreadyApplied(await submissionEvidence(ctx), ctx.job).catch(() => ({ applied: true, reason }));
      if (!prior.applied) {
        ctx.log(`  · not an earlier application for this job (${prior.reason.slice(0, 120)}); continuing`);
        return ok(`The page does not say this job was applied for before: ${prior.reason} A message that the candidate is known to this employer or must verify their email is a step to continue: sign in or verify the email (enter_emailed_code / open_emailed_link) and carry on with the application.`);
      }
      return { kind: 'terminal', outcome: { status: 'already-applied', reason } };
    }
    case 'nothing_to_apply_to':
      return { kind: 'terminal', outcome: { status: 'skipped', reason } };
    case 'cannot_complete':
      return { kind: 'terminal', outcome: { status: 'skipped', reason } };
    default:
      return ctx.guards.pendingFields.size || ctx.guards.ungrounded.length
        ? { kind: 'terminal', outcome: { status: 'needs-human', reason } }
        : { kind: 'terminal', outcome: { status: 'skipped', reason } };
  }
}
