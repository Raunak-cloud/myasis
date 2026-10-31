/**
 * When a job that stopped for the candidate's answers is worth opening again.
 *
 * The run used to compare the answer bank file's modification time with the
 * stop. The dashboard rewrites that file before every run, so it was always
 * newer and the check never held: every blocked job was opened again on every
 * run — listing, reading pause, fit check, a full application attempt and a
 * run slot — only to stop on the same unanswered question.
 */
import { blockedQuestionKey } from './blocked-questions.js';

/** A question as the answer bank keys it (dashboard answers.ts saveAnswers), compared without case. */
export function answerKey(question: string): string {
  return blockedQuestionKey({ question }).slice(0, 500).toLowerCase();
}

interface LastReview {
  at: string;
  status: string;
  questions?: ReadonlyArray<{ question?: unknown; prompt?: unknown }>;
  unansweredQuestions?: ReadonlyArray<{ question?: unknown; prompt?: unknown }>;
}

/**
 * True while the job should wait: it last stopped on questions only the
 * candidate can answer, and at least one remains unanswered.
 *
 * Anything else is opened as before — a stop with no questions (a security
 * check, a closed form, the step budget), every question answered after the stop,
 * or a record that cannot say (no questions exported, no answer times).
 */
export function waitingForAnswers(last: LastReview | undefined, answeredAt: ReadonlyMap<string, number> | null): boolean {
  // The exported current state already reconciles partial answers, dismissal
  // and delayed imports. Historical outcomes remain advisory evidence.
  if (last?.unansweredQuestions) return last.unansweredQuestions.length > 0;
  if (!last || last.status !== 'needs-human' || !answeredAt) return false;
  const stoppedAt = Date.parse(last.at);
  const asked = (last.questions ?? [])
    .map((item) => answerKey(blockedQuestionKey(item)))
    .filter(Boolean);
  if (!Number.isFinite(stoppedAt) || !asked.length) return false;
  return !asked.every((question) => (answeredAt.get(question) ?? 0) > stoppedAt);
}
