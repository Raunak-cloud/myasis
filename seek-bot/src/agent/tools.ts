import { config } from '../config.js';
import { captureInteractivePageState, waitForInteractivePageChange, waitForPageToSettle } from '../browser.js';
import { verifySubmissionEvidence } from '../llm.js';
import { isExternal } from './guards.js';
import { handleCaptchaWithCapMonster } from '../captcha.js';
import { hostOf } from '../site-auth.js';
import { recordWall } from '../site-walls.js';
import { runRawTool } from './raw-tools.js';
import { ToolResult, ToolContext, ok } from './tools/context.js';
import { rememberCoverLetterOpportunity, submissionEvidence } from './tools/gate.js';
import { doClick, doScroll, doClickPoint, doPressKey } from './tools/actions.js';
import { doChooseOption, doAcceptTerms, doAnswerQuestions } from './tools/answers.js';
import { doCompleteAuthentication, doEnterEmailedCode, EMAIL_WAIT_MS, doOpenEmailedLink } from './tools/auth.js';
import { doAddCoverLetter, doAttachResume } from './tools/documents.js';
import { doFinish } from './tools/finish.js';
export * from './tools/context.js';
export * from './tools/gate.js';
export * from './tools/schemas.js';
export * from './tools/actions.js';
export * from './tools/answers.js';
export * from './tools/auth.js';
export * from './tools/documents.js';
export * from './tools/finish.js';

/**
 * The most any one tool may take. A tool that never returns (a page that
 * stops answering an evaluate, a navigation that never commits) must not
 * freeze the run: the agent is told and re-observes instead. Generous enough
 * for the slow legitimate cases — a humanized letter, an email arriving.
 */
const TOOL_TIME_LIMIT_MS: Record<string, number> = {
  add_cover_letter: 300_000,
  enter_emailed_code: EMAIL_WAIT_MS + 60_000,
  open_emailed_link: EMAIL_WAIT_MS + 60_000,
  answer_questions: 180_000,
  attach_resume: 180_000,
  upload_file: 300_000,
  fill_element: 180_000,
  evaluate_script: 90_000,
};
const DEFAULT_TOOL_TIME_LIMIT_MS = 120_000;

export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  /**
   * Challenge controls never reach an AI-selected action. This also closes
   * the race where a CAPTCHA appears after observation but before the click.
   * Solved before the tool's clock starts: CapMonster has its own deadline
   * (200s a task, one retry), longer than any tool's, and inside the clock a
   * slow solve abandoned the tool mid-solve (Macquarie's registration page).
   */
  if (!('__parseError' in args)) {
    const captcha = await handleCaptchaWithCapMonster(ctx.page);
    if (captcha === 'solved') {
      // A clearing that took minutes is progress, not a stuck page.
      ctx.guards.recordProgress();
      return ok('CapMonster cleared the security verification. Re-observe the page and continue.');
    }
    if (captcha === 'blocked') {
      const reason = 'CapMonster could not clear the site security verification.';
      if (isExternal(ctx.page.url())) recordWall(hostOf(ctx.page.url()), reason);
      return { kind: 'terminal', outcome: { status: 'needs-human', reason } };
    }
  }
  const limit = TOOL_TIME_LIMIT_MS[name] ?? DEFAULT_TOOL_TIME_LIMIT_MS;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<ToolResult>((done) => {
    timer = setTimeout(() => {
      ctx.log(`  ⏱ ${name} did not finish within ${Math.round(limit / 1000)}s; continuing without it`);
      done(ok(`The ${name} call did not finish within ${Math.round(limit / 1000)} seconds and was abandoned. The page may have changed: re-observe before acting.`));
    }, limit);
  });
  try {
    return await Promise.race([runTool(ctx, name, args), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if ('__parseError' in args) {
    return ok('Your tool arguments were not valid JSON. Call the tool again with well-formed arguments.');
  }
  rememberCoverLetterOpportunity(ctx);
  switch (name) {
    case 'choose_option':
      return doChooseOption(ctx, args);
    case 'accept_terms':
      return doAcceptTerms(ctx, args);
    case 'wait_for_page': {
      /**
       * Waits for the page to change or to settle, whichever comes first.
       * It used to wait out the full ten seconds whenever nothing changed,
       * which over ten days was most calls: about six seconds an application
       * spent watching a page that had already finished loading.
       */
      const before = await captureInteractivePageState(ctx.page);
      const outcome = await Promise.race([
        waitForInteractivePageChange(ctx.page, before, 10_000).then((changed) => (changed ? 'changed' : 'timeout')),
        waitForPageToSettle(ctx.page, 2_000, 10_000).then((settled) => (settled ? 'settled' : 'timeout')),
      ]);
      if (outcome === 'changed') return ok('The page changed while waiting. Inspect the fresh observation.');
      if (outcome === 'settled') return ok('The page has finished loading and nothing is pending: nothing is going to change by itself. Inspect it and act; waiting again will not help.');
      return ok('No page change after waiting 10 seconds. Inspect the page before choosing a recovery action.');
    }
    case 'confirm_submission': {
      /**
       * The page is the authority, not the record of what was pressed. A form
       * can send itself on a control the gates never read as a submit (an
       * emailed-code "Next" on LiveHire lodged oOh!'s application), and the
       * agent, seeing the confirmation, was told no submit had been recorded
       * until the repeat detector ended the attempt. The independent verifier
       * still has to quote an explicit confirmation from the page, and only
       * an application with something entered can have been sent.
       */
      const sent = Boolean(ctx.captured.length || ctx.resumeUsed || ctx.coverLetter);
      if (!ctx.submissionAttempted && !sent) return ok('Nothing has been entered or sent for this application yet. Do not claim success; inspect the page.');
      const evidence = await submissionEvidence(ctx);
      if (await verifySubmissionEvidence(evidence, ctx.job)) {
        if (!ctx.submissionAttempted) ctx.log('  · the page confirms the application was received, though no control was read as its submit');
        return { kind: 'terminal', outcome: { status: 'applied' } };
      }
      return ok(ctx.submissionAttempted
        ? 'The employer page does not yet verify a completed submission. Inspect its validation or wait for confirmation.'
        : 'No submit has been pressed and the page does not confirm a submission. Find and press the form\'s own submit control; do not call this again until it has been pressed or the page says the application was received.');
    }
    case 'reload_page': {
      if (ctx.submissionAttempted || ctx.captured.length || ctx.resumeUsed || ctx.coverLetter) return ok('Reload withheld: application data was entered or submission attempted. Preserve the form and inspect its current state.');
      if ((ctx.reloads ?? 0) >= 2) return ok('Reload did not resolve this page after two attempts. Inspect other visible recovery controls; do not bypass access restrictions.');
      ctx.reloads = (ctx.reloads ?? 0) + 1;
      await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      return ok('Reload attempted. Inspect the fresh page; this is not application success.');
    }
    case 'click':
      return doClick(ctx, args);
    case 'complete_authentication':
      return doCompleteAuthentication(ctx, args);
    case 'answer_questions':
      return doAnswerQuestions(ctx, args);
    case 'add_cover_letter':
      return doAddCoverLetter(ctx, args);
    case 'attach_resume':
      return doAttachResume(ctx, args);
    case 'scroll':
      return doScroll(ctx, args);
    case 'finish':
      return doFinish(ctx, args);
    case 'enter_emailed_code':
      return doEnterEmailedCode(ctx, args);
    case 'open_emailed_link':
      return doOpenEmailedLink(ctx, args);
    case 'press_key':
      return doPressKey(ctx, args);
    case 'click_point':
      return doClickPoint(ctx, args);
    default:
      return (config.celeris.rawTools ? await runRawTool(ctx, name, args) : null) ?? ok(`No such tool "${name}".`);
  }
}
