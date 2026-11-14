import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JobListing } from './types.js';

export interface ApplicationSkipState { listing: string; context: string; access: string }
export const APPLICATION_OUTCOMES_FILE = 'application-outcomes.jsonl';
export function applicationOutcomeRows(path: string): any[] {
  if (!existsSync(path)) return [];
  try { return readFileSync(path, 'utf8').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch { return []; }
}
export function appendApplicationOutcome(directory: string, row: unknown) {
  mkdirSync(directory, { recursive: true });
  appendFileSync(resolve(directory, APPLICATION_OUTCOMES_FILE), '\n' + JSON.stringify(row) + '\n', { mode: 0o600 });
}
export function validApplicationJob(job: any): job is JobListing {
  return Boolean(job && typeof job.id === 'string' && typeof job.title === 'string'
    && typeof job.company === 'string' && typeof job.url === 'string' && typeof job.location === 'string');
}

/** Preserve actual attempt facts before the dashboard resets its run log.
 * This module deliberately needs no worker configuration or model imports. */
export function archiveApplicationOutcomes(directory: string): void {
  const identity = (row: any) => JSON.stringify([row.ts, row.jobId, row.status, row.technicalAttempt?.runId]);
  const known = new Set(applicationOutcomeRows(resolve(directory, APPLICATION_OUTCOMES_FILE)).filter(Boolean).map(identity));
  for (const row of applicationOutcomeRows(resolve(directory, 'run-log.jsonl'))) {
    if (!row || !validApplicationJob(row.technicalAttempt?.job) || row.jobId !== row.technicalAttempt.job.id || !Number.isFinite(Date.parse(row.ts))) continue;
    const id = identity(row); if (known.has(id)) continue;
    appendApplicationOutcome(directory, row); known.add(id);
  }
}
