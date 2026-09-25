import type { ApplyOutcome } from '../types.js';
import type { runApplicationAgent } from './loop.js';

type AgentRun = Awaited<ReturnType<typeof runApplicationAgent>>;

/**
 * The one translation from an agent run to the outcome a run records.
 *
 * SEEK, Indeed and direct employer URLs each used to carry their own copy of
 * this switch, and the copies drifted: the flag that stops an application
 * whose submit was pressed from ever being retried reached only SEEK's, so an
 * Indeed employer received the same application again on the next run.
 * Everything an outcome must carry is added here, once, for every board.
 */
export function outcomeFromRun(
  run: AgentRun,
  jobId: string,
  finalUrl: string,
  onFriction?: (kind: 'captcha' | 'identity') => void,
): ApplyOutcome {
  const extras = {
    ...(run.actions.length ? { actions: run.actions } : {}),
    ...(run.submitPressed ? { submitPressed: true } : {}),
  };
  switch (run.outcome.status) {
    case 'applied':
      return {
        status: 'applied',
        jobId,
        at: new Date().toISOString(),
        ...(run.site ? { site: run.site } : {}),
        coverLetter: run.coverLetter,
        answers: run.captured,
        ...extras,
      };
    case 'rehearsed':
      return { status: 'rehearsed', jobId, coverLetter: run.coverLetter, answers: run.captured, stoppedAt: run.outcome.stoppedAt, ...extras };
    case 'off-platform':
      return { status: 'off-platform', jobId, redirectedTo: run.outcome.redirectedTo, ...extras };
    case 'already-applied':
      return { status: 'already-applied', jobId, reason: run.outcome.reason, ...extras };
    case 'skipped':
      return { status: 'skipped', jobId, reason: run.outcome.reason, ...extras };
    case 'needs-human':
    default: {
      // Friction feeds the run-level abort counter, so repeated walls stop a board for the run.
      if (/captcha/i.test(run.outcome.reason)) onFriction?.('captcha');
      else if (/identity|work-rights/i.test(run.outcome.reason)) onFriction?.('identity');
      return {
        status: 'needs-human',
        jobId,
        reason: run.outcome.reason,
        url: finalUrl,
        ...(run.outcome.questions?.length ? { questions: run.outcome.questions } : {}),
        ...extras,
      };
    }
  }
}
