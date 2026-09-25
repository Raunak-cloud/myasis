import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import type { AppliedRecord, ApplyOutcome } from './types.js';
import type { ReviewCacheMetadata } from './review-cache.js';

const APPLIED = resolve(config.dataDir, 'applied.json');
const LOG = resolve(config.dataDir, 'run-log.jsonl');
const RUN_SUMMARY = resolve(config.dataDir, 'run-summary.json');

function ensureDir() {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
}

function loadApplied(): AppliedRecord[] {
  ensureDir();
  if (!existsSync(APPLIED)) return [];
  try {
    return JSON.parse(readFileSync(APPLIED, 'utf8')) as AppliedRecord[];
  } catch {
    return [];
  }
}

function saveApplied(records: AppliedRecord[]) {
  ensureDir();
  writeFileSync(APPLIED, JSON.stringify(records, null, 2));
}

/** company+title+location, normalised — matches the dedupe rule in seek.md. */
function dedupeKey(company: string, title: string, location: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(pty|ltd|limited|group|australia|au|inc|llc)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
  return `${norm(company)}::${norm(title)}::${norm(location)}`;
}

export class AppliedIndex {
  private records: AppliedRecord[];
  private keys: Set<string>;
  private ids: Set<string>;

  constructor() {
    this.records = loadApplied();
    this.keys = new Set(this.records.map((r) => dedupeKey(r.company, r.title, r.location)));
    this.ids = new Set(this.records.map((r) => r.jobId));
  }

  has(jobId: string, company: string, title: string, location: string): boolean {
    return this.ids.has(jobId) || this.keys.has(dedupeKey(company, title, location));
  }

  add(rec: AppliedRecord) {
    this.records.push(rec);
    this.ids.add(rec.jobId);
    this.keys.add(dedupeKey(rec.company, rec.title, rec.location));
    saveApplied(this.records);
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

export function logOutcome(outcome: ApplyOutcome & { title?: string; company?: string; reviewCache?: ReviewCacheMetadata }) {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...outcome });
  writeFileSync(LOG, line + '\n', { flag: 'a' });
}

/** Past outcomes are context for model triage, never a permanent rejection. */
export function recentReviewFeedback(): Map<string, { at: string; status: string; reason: string }> {
  const result = new Map<string, { at: string; status: string; reason: string }>();
  try {
    const paths = [resolve(config.dataDir, 'review-history.jsonl'), LOG];
    const lines = paths.filter(existsSync).flatMap(path => readFileSync(path, 'utf8').trim().split('\n'));
    for (const line of lines.slice(-2000)) {
      try {
        const row = JSON.parse(line);
        const age = Date.now() - Date.parse(row.ts);
        if (!Number.isFinite(age) || age < 0 || age > 7 * 86400_000 || !row.jobId || !row.title || !row.company) continue;
        const reason = row.reason || row.error || row.redirectedTo;
        if (typeof reason !== 'string') continue;
        result.set(JSON.stringify([row.jobId, row.title, row.company]), { at: row.ts, status: row.status, reason: reason.slice(0, 1200) });
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
export function saveRunSummary(qualifyingJobs: number): void {
  ensureDir();
  writeFileSync(RUN_SUMMARY, JSON.stringify({ qualifyingJobs, completedAt: new Date().toISOString() }, null, 2));
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
    if (!s.title || index.has(s.id, s.blob, s.title, s.blob)) continue;
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
