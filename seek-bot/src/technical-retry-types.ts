import type { JobListing } from './types.js';
import type { PreparedApplication } from './application-review-types.js';

export const TECHNICAL_RETRY_FILE = 'technical-retries.json';
export const TECHNICAL_RETRY_REQUEST = 'owtomate:technical-retry-fallback';
export const TECHNICAL_RETRY_RESPONSE = 'owtomate:technical-retry-fallback-result';
export const PREPAID_RETRY_SUBMITTED = 'owtomate:prepaid-retry-submitted';

export interface TechnicalAttempt {
  job: JobListing;
  runId: string;
  approval?: {id:string;revision:string};
}
export interface TechnicalRetryCandidate {
  key: string;
  job: JobListing;
  reason: string;
  failedAt: string;
  approval?: PreparedApplication;
}

/** Use the existing attempt status and send evidence, never a second fit review. */
export function technicalFailure(value: Record<string, unknown>): boolean {
  if (value.submitPressed === true || value.fitRejection || value.accountAccess
    || Array.isArray(value.questions) && value.questions.length) return false;
  if (value.status === 'error') return true;
  return ['skipped','needs-human'].includes(String(value.status))
    && /budget|allowance|infrastructure|browser.*closed|time.*limit|technical|error|fail(?:ed|ure)|disconnect|timed?\s*out|timeout|captcha|verification/i.test(String(value.reason ?? value.error ?? ''));
}

export function retryShortfall(onlineMatches: number, runLimit: number, dailyRemaining: number): number {
  return Math.max(0,Math.floor(Math.min(runLimit,dailyRemaining))-onlineMatches);
}
