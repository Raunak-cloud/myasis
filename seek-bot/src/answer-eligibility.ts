import { waitingForAnswers } from './answer-gate.js';
import { applicationUrlKey } from './application-identity.js';
import { jobBoardForUrl } from './job-board-url.js';
import { recentReviewFeedback } from './store.js';
import { candidateSavedAnswers } from './agent/agent-only-evidence.js';
import { verifiedQuestionSnapshot } from './question-snapshot-node.js';
import { questionAnswerable, questionResponseIssue } from './question-snapshot.js';
import { blockedQuestionKey } from './blocked-question-key.js';
import type { JobListing } from './types.js';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

let currentState: { directory: string; signature: string; feedback: ReturnType<typeof recentReviewFeedback> } | undefined;
function feedbackAtAdmission(): ReturnType<typeof recentReviewFeedback> {
  const directory = config.dataDir;
  const signature = ['attention.json', 'review-history.jsonl', 'run-log.jsonl'].map(name => {
    try { const s = statSync(resolve(directory, name), { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
  }).join('|');
  // Check source identity on every admission, but do not parse thousands of
  // unchanged historical rows for every search card. No eligibility decision
  // or saved answer is cached, and account switches invalidate this view.
  if (!currentState || currentState.directory !== directory || currentState.signature !== signature)
    currentState = { directory, signature, feedback: recentReviewFeedback() };
  return currentState.feedback;
}

/** Operational readiness is separate from suitability. Only authoritative
 * current captured questions hold a normal attempt; old labels are recaptured.
 * The active owner environment resolves every read at admission time. */
export function waitingForCurrentAnswers(job: JobListing, phase: 'application' | 'preparation' = 'application'): boolean {
  // A job/letter draft does not need answers to an application it has not filled.
  if(phase==='preparation')return false;
  const pending = [...feedbackAtAdmission()].flatMap(([key, feedback]) => {
    const [jobId] = JSON.parse(key) as string[];
    if (jobId !== job.id || !feedback.url || feedback.unansweredQuestions === undefined) return [];
    const board = jobBoardForUrl(feedback.url);
    if (board ? board !== (job.platform ?? 'seek') : ![job.url, job.applicationUrl].some(url => url && applicationUrlKey(url) === applicationUrlKey(feedback.url!))) return [];
    // The current pending task establishes the need for an answer. Custom
    // employer validation may require controls without native required markup.
    return feedback.unansweredQuestions.filter(question => verifiedQuestionSnapshot(question.snapshot)
      && questionAnswerable(question.snapshot));
  });
  if (!pending.length) return false;
  const answered = new Set(candidateSavedAnswers(true).flatMap(answer => verifiedQuestionSnapshot(answer.snapshot)
    && questionResponseIssue(answer.snapshot, answer.response) === null ? [blockedQuestionKey({ snapshot: answer.snapshot })] : []));
  return waitingForAnswers({ at: '', status: 'needs-human',
    unansweredQuestions: pending.filter(question => !answered.has(blockedQuestionKey(question))) }, null);
}
