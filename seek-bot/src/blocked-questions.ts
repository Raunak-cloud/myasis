import type { ApplyOutcome, BlockedQuestion } from './types.js';

/** The same actionable question payload is used by the run and Needs attention. */
export function normaliseBlockedQuestions(raw: unknown): BlockedQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: BlockedQuestion[] = [];
  for (const entry of raw) {
    const item = typeof entry === 'string' ? { question: entry } : entry && typeof entry === 'object' ? entry : {};
    if (typeof item.question !== 'string') continue;
    const question = item.question.replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
    // Credentials must never be requested or stored in the plain-text answer bank.
    if (!question || /\bpass(word|phrase)\b/i.test(question)) continue;
    const prompt = typeof item.prompt === 'string' ? item.prompt.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    const options = Array.isArray(item.options) ? item.options.map(String).filter(Boolean) : [];
    const kind = ['text', 'textarea', 'select', 'radio', 'checkbox'].includes(item.kind) ? item.kind as BlockedQuestion['kind'] : undefined;
    questions.push({ question, ...(prompt ? { prompt } : {}), ...(kind ? { kind } : {}), ...(options.length ? { options } : {}) });
  }
  return questions;
}

/** A stopped attempt is an attention task only when the candidate can answer it. */
export function normaliseAttentionOutcome(outcome: ApplyOutcome): ApplyOutcome {
  if (outcome.status !== 'needs-human') return outcome;
  const questions = normaliseBlockedQuestions(outcome.questions).slice(0, 30);
  if (questions.length) return { ...outcome, questions };
  return {
    status: 'skipped', jobId: outcome.jobId, reason: outcome.reason,
    ...(outcome.actions?.length ? { actions: outcome.actions } : {}),
    ...(outcome.submitPressed ? { submitPressed: true } : {}),
  };
}
