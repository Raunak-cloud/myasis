import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from '../../config.js';
import type { JobListing } from '../../types.js';
import { isExternal } from '../browser-boundaries.js';
import type { AgentTermination } from '../context.js';
import { currentAttempt, recordDiagnostic } from '../attempt-diagnostics.js';

// Audit records shared by the active application agent.

export interface TraceStep {
  step: number;
  url: string;
  tool: string;
  args: Record<string, unknown>;
  /** Human-readable version of the call, e.g. `click "Apply without an account"`. */
  label: string;
  result?: string;
  /** Recorded before execution; a missing completion identifies outstanding work. */
  startedAt?: string;
  completedAt?: string;
  disposition?: string;
  /** The image observed before this decision, when a capture was available. */
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

/** Keep the latest-job aliases for compatibility; retain a distinct, atomic attempt record. */
export function persistLiveTrace(job: JobListing, trace: TraceStep[]): void {
  saveTrace(job, { mode: 'agent-only', status: 'in-progress', steps: trace }, `${job.id}.live.json`);
}

function saveTrace(job: JobListing, body: Record<string, unknown>, latest: string): void {
  try {
    const identity = currentAttempt();
    const dir = TRACE_DIR();
    mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ jobId: job.id, title: job.title, company: job.company, ...identity,
      ...body, savedAt: new Date().toISOString() });
    for (const name of [...(identity ? [`attempt-${identity.attemptId}.json`] : []), latest]) {
      const file = resolve(dir, name), temporary = file + `.${randomUUID()}.tmp`;
      writeFileSync(temporary, payload, { mode: 0o600 });
      renameSync(temporary, file);
    }
  } catch (error) {
    recordDiagnostic({ severity: 'error', category: 'trace_write_error', stage: 'logging', message: 'Could not save application steps.', error });
  }
}

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

/** Owner-local experience is advice about interactions, never saved candidate answers. */
export function browserExperience(url: string): string {
  const host = hostOf(url);
  const hint = loadSiteHints()[host];
  return JSON.stringify({ host, hint: hint ?? null, instruction: 'Historical interaction evidence only. Inspect the current page and match its controls before reusing an approach. Never reuse a previous candidate answer, stale ref or assumed receipt.' });
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
    saveTrace(job, { outcome, finalUrl, steps: trace }, `${job.id}.json`);
    const host = hostOf(finalUrl);
    if (outcome.status === 'applied' && host && isExternal(finalUrl) && trace.length) {
      const hints = loadSiteHints();
      const commands = trace.flatMap(step => step.tool === 'browser_batch' && Array.isArray(step.args.actions)
        ? step.args.actions as Record<string, unknown>[] : step.tool === 'browser_action' ? [step.args] : []);
      // Store only interaction types and explicit locators, never answer values,
      // private credentials, scripts or transient observation refs.
      hints[host] = { steps: commands.filter(command => (command.locator || command.selector)
        && !/^frame\d+$/.test(String((command.locator as { frame?: string } | undefined)?.frame ?? '')))
        .map(command => JSON.stringify({ action: command.action, locator: command.locator, selector: command.selector })).slice(0, 40), updatedAt: new Date().toISOString() };
      writeFileSync(SITE_HINTS(), JSON.stringify(hints, null, 2));
    }
  } catch {
    /* a missing trace must never fail an application */
  }
}
