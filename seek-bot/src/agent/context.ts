import type { Page } from 'patchright';
import type { ApplicationAction, BlockedQuestion, CandidateProfile, FitRejection, JobListing } from '../types.js';
import type { Observation } from './observe.js';
import type { SiteCredential } from '../site-auth.js';
import { jobBoardForHost } from '../job-board-url.js';

export type AgentTermination =
  | { status: 'applied' }
  | { status: 'prepared'; draft: import('../application-review-types.js').PreparedApplication }
  | { status: 'rehearsed'; stoppedAt: string }
  | {
      status: 'needs-human';
      /** Plain language, shown to the candidate. */
      reason: string;
      /** The technical version, for the log and the trace only. */
      detail?: string;
      questions?: BlockedQuestion[];
    }
  | { status: 'off-platform'; redirectedTo: string }
  | { status: 'already-applied'; reason: string }
  | { status: 'skipped'; reason: string; fitRejection?: FitRejection };

/** Expected handoffs need a fresh observation, not expensive failure recovery.
 * Keep this separate from prose, which can quote arbitrary form wording. */
export type ToolDisposition = 'completed' | 'reobserve' | 'failed' | 'invalid-arguments';
export type ToolResult = { kind: 'ok'; message: string; disposition?: ToolDisposition } | { kind: 'terminal'; outcome: AgentTermination };

export interface ToolContext {
  page: Page;
  job: JobListing;
  profile: CandidateProfile;
  observation: Observation;
  captured: Array<{ question: string; answer: string }>;
  coverLetter?: string;
  pendingCredentials?: Map<string, SiteCredential>;
  resumeUsed?: string;
  resumeName?: string;
  log: (line: string) => void;
  actions: ApplicationAction[];
  submissionAttempted?: boolean;
}

export const ok = (message: string, disposition?: ToolDisposition): ToolResult => ({ kind: 'ok', message, ...(disposition ? { disposition } : {}) });

/** Records a side effect once per kind and site, and says so in the run log. */
export function noteAction(ctx: ToolContext, action: Omit<ApplicationAction, 'at'>): void {
  if (ctx.actions.some((known) => known.kind === action.kind && known.site === action.site && known.purpose === action.purpose)) return;
  ctx.actions.push({ ...action, at: new Date().toISOString() });
}

/** A site named the way the candidate knows it. */
export function siteName(host: string): string {
  const board = jobBoardForHost(host);
  if (board === 'seek') return 'SEEK';
  if (board === 'indeed') return 'Indeed';
  return host;
}
