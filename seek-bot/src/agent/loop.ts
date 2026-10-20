import type { Page } from 'patchright';
import type { ApplicationAction, CandidateProfile, JobListing } from '../types.js';
import type { AgentTermination } from './tools/context.js';
import { EmployerBrowserRouter } from '../employer-browser-router.js';
import { outsideScope } from '../run-scope.js';
import { withJobCost } from '../cost-ledger.js';
import { config } from '../config.js';
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
  /** Internal attempt-owned routing, used by the application agent. */
  routeEmployerPage?: (page: Page) => Promise<Page>;
}

export function runApplicationAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  return withJobCost(options.job.id, async () => {
    const router = new EmployerBrowserRouter();
    const routeEmployerPage = (page: Page) => options.simulation || !config.allowExternalApply || outsideScope('external') ? Promise.resolve(page) : router.route(page);
    try {
      const routed = { ...options, page: await routeEmployerPage(options.page), routeEmployerPage };
      return await runAgentOnlyApplication(routed);
    } finally { await router.close(); }
  });
}
