import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../config.js';
import type { JobListing } from '../../types.js';
import { isExternal } from '../guards.js';
import type { AgentTermination } from '../tools.js';

// Audit records shared by the active application agent.

export interface TraceStep {
  step: number;
  url: string;
  tool: string;
  args: Record<string, unknown>;
  /** Human-readable version of the call, e.g. `click "Apply without an account"`. */
  label: string;
  result?: string;
  disposition?: string;
  screenshot?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const SITE_HINTS = () => resolve(config.dataDir, 'site-hints.json');
export const TRACE_DIR = () => resolve(config.dataDir, 'traces');

interface SiteHint {
  steps: string[];
  updatedAt: string;
}

function loadSiteHints(): Record<string, SiteHint> {
  try {
    return existsSync(SITE_HINTS()) ? (JSON.parse(readFileSync(SITE_HINTS(), 'utf8')) as Record<string, SiteHint>) : {};
  } catch {
    return {};
  }
}

/**
 * Keeps the record a person would want: the full step-by-step trace, with
 * screenshots, for anything that needs them; and for an employer site that
 * was completed, the step outline as a hint for the next application there.
 */
export function persistTrace(job: JobListing, outcome: AgentTermination, trace: TraceStep[], finalUrl: string): void {
  try {
    // Successful applications need the same audit trail: recovery mistakes
    // can happen before confirmation too. Existing trace retention applies.
    if (outcome.status === 'needs-human' || outcome.status === 'skipped' || outcome.status === 'applied' || outcome.status === 'rehearsed') {
      mkdirSync(TRACE_DIR(), { recursive: true });
      writeFileSync(
        resolve(TRACE_DIR(), `${job.id}.json`),
        JSON.stringify({ jobId: job.id, title: job.title, company: job.company, outcome, finalUrl, savedAt: new Date().toISOString(), steps: trace }),
      );
    }
    const host = hostOf(finalUrl);
    if ((outcome.status === 'applied' || outcome.status === 'rehearsed') && host && isExternal(finalUrl) && trace.length) {
      const hints = loadSiteHints();
      hints[host] = { steps: trace.map((step) => step.label).slice(0, 40), updatedAt: new Date().toISOString() };
      writeFileSync(SITE_HINTS(), JSON.stringify(hints, null, 2));
    }
  } catch {
    /* a missing trace must never fail an application */
  }
}
