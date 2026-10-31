import type { ApplyOutcome, BlockedQuestion } from './types.js';
import { blockedQuestionKey } from './blocked-question-key.js';
export { blockedQuestionKey };

export function isCredentialQuestion(item: { question?: unknown; prompt?: unknown }): boolean {
  return [item?.question, item?.prompt].some(value => typeof value === 'string' && /\bpass(word|phrase)\b/i.test(value));
}

/** The same actionable question payload is used by the run and Needs attention. */
export function normaliseBlockedQuestions(raw: unknown): BlockedQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: BlockedQuestion[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = typeof entry === 'string' ? { question: entry } : entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    if (typeof item.question !== 'string') continue;
    const question = blockedQuestionKey({ question: item.question });
    // Credentials must never be requested or stored in the plain-text answer bank.
    if (!question || question.length > 500 || isCredentialQuestion(item)) continue;
    const prompt = typeof item.prompt === 'string' ? item.prompt.replace(/\s+/g, ' ').trim() : '';
    if (prompt.length > 500) continue;
    const key = blockedQuestionKey({ question, prompt });
    if (seen.has(key)) continue;
    seen.add(key);
    const options: string[] = Array.isArray(item.options) ? [...new Set((item.options as unknown[]).filter((option): option is string => typeof option === 'string').map(option => option.trim()).filter(Boolean))] : [];
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
    ...(outcome.applicationUrl ? { applicationUrl: outcome.applicationUrl } : {}),
  };
}
