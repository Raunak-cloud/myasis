import type { Page } from 'patchright';
import type { ApplicationAction, CandidateProfile, JobListing } from '../types.js';
import type { AgentTermination } from './context.js';
import { withJobCost } from '../cost-ledger.js';
import { runAgentOnlyApplication } from './agent-only.js';

export interface AgentRunResult {
  outcome: AgentTermination;
  captured: Array<{ question: string; answer: string }>;
  coverLetter?: string;
  resumeUsed?: string;
  /** The board file name the resume went out as. */
  resumeName?: string;
  /** Side effects the candidate must be told about, whatever the outcome. */
  actions: ApplicationAction[];
  /** The employer site the attempt ended on, when it left the job board. */
  site?: string;
  applicationUrl?: string;
  /** The application's own submit control was pressed during this attempt. */
  submitPressed: boolean;
  steps: number;
  usage: string;
}

export interface AgentRunOptions {
  /** Local, reserved-domain dry-run fixtures only. */
  simulation?: 'isolated-form';
  page: Page;
  job: JobListing;
  profile: CandidateProfile;
  log?: (line: string) => void;
}

/** Board handoffs and employer forms stay in the account's native browser. */
export function runApplicationAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  return withJobCost(options.job.id, () => runAgentOnlyApplication(options));
}
