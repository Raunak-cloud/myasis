import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { config } from './config.js';
import type { AppliedRecord, ApplyOutcome } from './types.js';
import type { ReviewCacheMetadata } from './review-cache.js';
import { recordSubmittedCost } from './cost-ledger.js';
import { sameApplication } from './application-identity.js';
import type { JobListing } from './types.js';

const appliedPath = () => resolve(config.dataDir, 'applied.json');
const outcomeLogPath = () => resolve(config.dataDir, 'run-log.jsonl');
const runSummaryPath = () => resolve(config.dataDir, 'run-summary.json');

function ensureDir(directory = config.dataDir) {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
}

function loadApplied(path: string): AppliedRecord[] {
  ensureDir(dirname(path));
  if (!existsSync(path)) return [];
  try {
    const records: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(records)) throw new Error('Invalid application history shape');
    return records as AppliedRecord[];
  } catch {
    throw new Error('Saved application history could not be read; new applications are withheld to prevent repeat submissions.');
  }
}

function saveApplied(records: AppliedRecord[], path: string) {
  ensureDir(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(records, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

export class AppliedIndex {
  private readonly path: string;
  private records: AppliedRecord[];

  constructor() {
    this.path = appliedPath();
    this.records = loadApplied(this.path);
  }

  hasApplication(job: JobListing): boolean {
    return this.records.some(record => sameApplication(record, job));
  }

  add(rec: AppliedRecord) {
    this.records.push(rec);
    saveApplied(this.records, this.path);
  }

  /**
   * Submissions since local midnight.
   *
   * Compared as UTC dates this reset at 10 am in Sydney, so the bot's "today"
   * and the dashboard's disagreed for most of every day, and a morning run
   * could stop on yesterday afternoon's applications.
   */
  appliedToday(): number {
    const timeZone = process.env.RUN_TIME_ZONE?.trim() || 'Australia/Sydney';
    const day = (at: Date) => at.toLocaleDateString('en-CA', { timeZone });
    const today = day(new Date());
    return this.records.filter(
      (r) =>
        day(new Date(r.appliedAt)) === today &&
        (r.submittedByMyasis ?? (r.score > 0 || Boolean(r.coverLetter))),
    ).length;
  }

  get all(): AppliedRecord[] {
    return this.records;
  }
}

export function logOutcome(outcome: ApplyOutcome & { title?: string; company?: string; url?: string; reviewId?: string; reviewCache?: ReviewCacheMetadata }) {
  if (outcome.status === 'applied') recordSubmittedCost(outcome.jobId);
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...outcome });
  writeFileSync(outcomeLogPath(), line + '\n', { flag: 'a' });
}

interface ReviewFeedback {
  at: string;
  status: string;
  reason: string;
  /** The questions a needs-human stop was waiting on, when it was. */
  questions?: Array<{ question?: unknown }>;
}

/** Past outcomes are context for model triage, never a permanent rejection. */
export function recentReviewFeedback(): Map<string, ReviewFeedback> {
  const result = new Map<string, ReviewFeedback>();
  try {
    const paths = [resolve(config.dataDir, 'review-history.jsonl'), outcomeLogPath()];
    const lines = paths.filter(existsSync).flatMap(path => readFileSync(path, 'utf8').trim().split('\n'));
    for (const line of lines.slice(-2000)) {
      try {
        const row = JSON.parse(line);
        const age = Date.now() - Date.parse(row.ts);
        if (!Number.isFinite(age) || age < 0 || age > 7 * 86400_000 || !row.jobId || !row.title || !row.company) continue;
        const reason = row.reason || row.error || row.redirectedTo;
        if (typeof reason !== 'string') continue;
        result.set(JSON.stringify([row.jobId, row.title, row.company]), {
          at: row.ts, status: row.status, reason: reason.slice(0, 1200),
          ...(Array.isArray(row.questions) ? { questions: row.questions } : {}),
        });
      } catch { /* A partial log line must not break discovery. */ }
    }
  } catch { /* A new account has no history. */ }
  return result;
}

/**
 * A small machine-readable handoff to the dashboard after a run.
 *
 * The dashboard must not scrape console wording to decide whether a search
 * was sparse: log copy changes, whereas this file is an explicit contract.
 * `exportUserForRun` removes the previous file before every run, so a failed
 * run can never accidentally reuse an older result.
 */
/**
 * How many jobs qualified, and whether review got through every listing it
 * found. A run that stops at its cap has not shown the search to be sparse,
 * whatever the count, so only a complete review says anything about the terms.
 */
export function saveRunSummary(qualifyingJobs: number, reviewComplete = true): void {
  ensureDir();
  writeFileSync(runSummaryPath(), JSON.stringify({ qualifyingJobs, reviewComplete, completedAt: new Date().toISOString() }, null, 2));
}

/**
 * Seeds the local dedupe store from SEEK's own "Applied jobs" page, so a fresh
 * install does not re-apply to everything already submitted by hand.
 */
export async function syncFromSeek(page: import('patchright').Page): Promise<number> {
  await page.goto(`${config.seekBase}/my-activity/applied-jobs`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const scraped = await page.evaluate(() => {
    const out: any[] = [];
    document.querySelectorAll('a[href*="/job/"]').forEach((a) => {
      const el = a as HTMLAnchorElement;
      const id = el.href.match(/\/job\/(\d+)/)?.[1];
      if (!id) return;
      const card = el.closest('article, [data-testid], li, div[role="listitem"]');
      const txt = card?.textContent ?? '';
      out.push({ id, title: el.textContent?.trim() ?? '', blob: txt.slice(0, 400) });
    });
    return out;
  });

  const index = new AppliedIndex();
  let added = 0;
  for (const s of scraped) {
    if (!s.title || index.hasApplication({ id: s.id, platform: 'seek', url: `${config.seekBase}/job/${s.id}`, company: s.blob, title: s.title, location: s.blob })) continue;
    index.add({
      jobId: s.id,
      title: s.title,
      company: s.blob.replace(s.title, '').trim().slice(0, 80) || 'Unknown',
      location: 'Unknown',
      url: `${config.seekBase}/job/${s.id}`,
      appliedAt: new Date().toISOString(),
      score: 0,
      platform: 'seek',
      submittedByMyasis: false,
    });
    added++;
  }
  return added;
}
