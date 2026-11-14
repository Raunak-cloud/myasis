import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { employerName } from './employer-account.js';
import { listingFingerprint } from './review-cache.js';
import { technicalFailure } from './technical-retry-types.js';
import type { ApplyOutcome, JobListing } from './types.js';
import { APPLICATION_OUTCOMES_FILE, applicationOutcomeRows, appendApplicationOutcome, validApplicationJob,
  type ApplicationSkipState } from './application-outcome-journal.js';

interface Entry { job: JobListing; reason: string; state: ApplicationSkipState }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (job: JobListing) => `${job.platform ?? 'seek'}:${job.id}`;

/** Compare owner-local account metadata without exposing credentials. Unrelated
 * employers do not wake a skipped application. Legacy unscoped records are
 * conservatively included so adding a usable login can always release it. */
function accountState(directory: string, job: JobListing): { signature: string; changedAt: number } | undefined {
  const selected: unknown[] = []; let changedAt = 0;
  const company = employerName(job.company);
  const hosts = [job.url, job.applicationUrl].flatMap(raw => { try { return raw ? [new URL(raw).hostname] : []; } catch { return []; } });
  for (const file of ['site-credentials.json', 'pending-site-credentials.json']) {
    const path = resolve(directory, file);
    if (!existsSync(path)) continue;
    try {
      const records = JSON.parse(readFileSync(path, 'utf8'));
      if (!records || typeof records !== 'object' || Array.isArray(records)) return;
      for (const [id, record] of Object.entries(records).sort(([a], [b]) => a.localeCompare(b))) {
        if (!record || typeof record !== 'object') return;
        const value = record as Record<string, unknown>;
        let name = typeof value.employer === 'string' ? employerName(value.employer) : '';
        if (!name && file === 'pending-site-credentials.json') { try { name = employerName(JSON.parse(id)[2] ?? ''); } catch { /* Legacy key. */ } }
        if (name && name !== company && !hosts.some(host => id.includes(host))) continue;
        selected.push([file, id, record]);
        const at = Date.parse(String(value.at ?? ''));
        if (Number.isFinite(at)) changedAt = Math.max(changedAt, at);
      }
    } catch { return; } // Unreadable account state cannot justify suppressing work.
  }
  return { signature: hash(selected), changedAt };
}

function finalSkip(row: Record<string, unknown>): boolean {
  return row.status === 'skipped' && row.submitPressed !== true && !row.accountAccess
    && !(Array.isArray(row.questions) && row.questions.length) && !technicalFailure(row);
}

/** Application outcomes are distinct from immutable suitability reviews.
 * Reuse the agent's final skip only for the same board listing, card, owner
 * context and account state. Technical failures remain in the retry flow. */
export class ApplicationSkipMemory {
  private entries = new Map<string, Entry>();
  constructor(private directory = config.dataDir, now = Date.now()) {
    const rows = [APPLICATION_OUTCOMES_FILE, 'run-log.jsonl'].flatMap(file => applicationOutcomeRows(resolve(directory, file)));
    for (const row of rows.filter(row => row && Number.isFinite(Date.parse(row.ts)) && Date.parse(row.ts) <= now)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
      const job = row.technicalAttempt?.job;
      if (!validApplicationJob(job) || row.jobId !== job.id) continue;
      this.entries.delete(key(job));
      if (!finalSkip(row) || typeof row.reason !== 'string') continue;
      const access = accountState(directory, job);
      if (!access) continue;
      let state: ApplicationSkipState | undefined = row.applicationSkip;
      // Existing attempts already carry the discovery card and fit context.
      // Adopt them read-only if no relevant account change followed the skip.
      if (!state && job.discoveryFingerprint && job.fitReview?.contextFingerprint && access.changedAt <= Date.parse(row.ts)) {
        state = { listing: job.discoveryFingerprint, context: job.fitReview.contextFingerprint, access: access.signature };
      }
      if (state && [state.listing, state.context, state.access].every(value => typeof value === 'string' && value.length > 0)) {
        this.entries.set(key(job), { job, reason: row.reason, state });
      }
    }
  }

  prior(job: JobListing, context: string): Entry | undefined {
    const entry = this.entries.get(key(job));
    if (!entry || entry.state.context !== context || entry.state.listing !== (job.discoveryFingerprint ?? listingFingerprint(job))) return;
    return accountState(this.directory, entry.job)?.signature === entry.state.access ? entry : undefined;
  }

  remember(job: JobListing, outcome: ApplyOutcome, context: string): ApplicationSkipState | undefined {
    this.entries.delete(key(job));
    const access = finalSkip(outcome) ? accountState(this.directory, job) : undefined;
    const state = access ? { listing: job.discoveryFingerprint ?? listingFingerprint(job), context, access: access.signature } : undefined;
    try { appendApplicationOutcome(this.directory, { ts: new Date().toISOString(), ...outcome, technicalAttempt: { job }, ...(state ? { applicationSkip: state } : {}) }); }
    catch { console.warn('  ! Application outcome memory could not be saved; normal outcome reporting will continue.'); }
    if (state) this.entries.set(key(job), { job, state, reason: (outcome as Extract<ApplyOutcome, { status: 'skipped' }>).reason });
    return state;
  }
}
