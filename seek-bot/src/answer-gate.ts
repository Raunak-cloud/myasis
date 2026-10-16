/**
 * When a job that stopped for the candidate's answers is worth opening again.
 *
 * The run used to compare the answer bank file's modification time with the
 * stop. The dashboard rewrites that file before every run, so it was always
 * newer and the check never held: every blocked job was opened again on every
 * run — listing, reading pause, fit check, a full application attempt and a
 * run slot — only to stop on the same unanswered question.
 */

/** A question as the answer bank keys it (dashboard answers.ts saveAnswers), compared without case. */
export function answerKey(question: string): string {
  return question.replace(/\s+/g, ' ').trim().slice(0, 500).toLowerCase();
}

interface LastReview {
  at: string;
  status: string;
  questions?: ReadonlyArray<{ question?: unknown }>;
}

/**
 * True while the job should wait: it last stopped on questions only the
 * candidate can answer, and none of them has been answered since.
 *
 * Anything else is opened as before — a stop with no questions (a security
 * check, a closed form, the step budget), a question answered after the stop,
 * or a record that cannot say (no questions exported, no answer times).
 */
export function waitingForAnswers(last: LastReview | undefined, answeredAt: ReadonlyMap<string, number> | null): boolean {
  if (!last || last.status !== 'needs-human' || !answeredAt) return false;
  const stoppedAt = Date.parse(last.at);
  const asked = (last.questions ?? [])
    .map((item) => (typeof item?.question === 'string' ? answerKey(item.question) : ''))
    .filter(Boolean);
  if (!Number.isFinite(stoppedAt) || !asked.length) return false;
  return !asked.some((question) => (answeredAt.get(question) ?? 0) > stoppedAt);
}
