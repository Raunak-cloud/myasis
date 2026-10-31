import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { config } from './config.js';
import type { AppliedRecord, ApplyOutcome } from './types.js';
import type { ReviewCacheMetadata } from './review-cache.js';
import { recordSubmittedCost } from './cost-ledger.js';
import { sameApplication } from './application-identity.js';
import type { JobListing } from './types.js';
import { blockedQuestionKey, normaliseBlockedQuestions } from './blocked-questions.js';
import type { BlockedQuestion } from './types.js';

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
        r.confirmationStatus !== 'unconfirmed' &&
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
  if (outcome.reviewCache) writeFileSync(resolve(config.dataDir, 'review-cache.jsonl'), JSON.stringify({
    ...outcome.reviewCache, jobId: outcome.jobId, title: outcome.title, company: outcome.company,
    reason: 'reason' in outcome ? outcome.reason : outcome.status, reviewedAt: new Date().toISOString(),
  }) + '\n', { flag: 'a' });
}

interface ReviewFeedback {
  at: string;
  status: string;
  reason: string;
  /** The questions a needs-human stop was waiting on, when it was. */
  questions?: Array<{ question?: unknown; prompt?: unknown }>;
  /** Current owner state; an empty array explicitly resolves historical questions. */
  unansweredQuestions?: BlockedQuestion[];
}

/** Past outcomes are context for model triage, never a permanent rejection. */
export function recentReviewFeedback(): Map<string, ReviewFeedback> {
  const result = new Map<string, ReviewFeedback>();
  let snapshotAt: number | undefined;
  const outstanding = new Map<string, { title: string; company: string; reason: string; at: string; questions: BlockedQuestion[] }>();
  try {
    const state = JSON.parse(readFileSync(resolve(config.dataDir, 'attention.json'), 'utf8'));
    const at = Date.parse(state.asOf);
    if (Number.isFinite(at) && Array.isArray(state.items)) {
      snapshotAt = at;
      for (const item of state.items) {
        const questions = normaliseBlockedQuestions(item?.questions);
        if (typeof item?.jobId === 'string' && typeof item.title === 'string' && typeof item.company === 'string' && typeof item.reason === 'string' && typeof item.at === 'string' && questions.length) {
          outstanding.set(item.jobId, { title: item.title, company: item.company, reason: item.reason, at: item.at, questions });
        }
      }
    }
  } catch { /* Legacy exports have no current question snapshot. */ }
  try {
    const paths = [resolve(config.dataDir, 'review-history.jsonl'), outcomeLogPath()];
    const lines = paths.filter(existsSync).flatMap(path => readFileSync(path, 'utf8').trim().split('\n'));
    for (const line of lines.slice(-2000)) {
      try {
        const row = JSON.parse(line);
          if (snapshotAt !== undefined && typeof row.jobId === 'string' && Date.parse(row.ts) > snapshotAt) {
            const questions = normaliseBlockedQuestions(row.questions);
            if (row.status === 'needs-human' && questions.length && typeof row.title === 'string' && typeof row.company === 'string') {
              outstanding.set(row.jobId, { title: row.title, company: row.company, reason: row.reason ?? '', at: row.ts, questions });
            } else if (row.status === 'answered' && Array.isArray(row.questions) && row.questions.length) {
              const answered = new Set(questions.map(blockedQuestionKey));
              const current = outstanding.get(row.jobId);
              if (current) {
                const remaining = current.questions.filter(question => !answered.has(blockedQuestionKey(question)));
                if (remaining.length) outstanding.set(row.jobId, { ...current, questions: remaining });
                else outstanding.delete(row.jobId);
              }
            } else if (['prepared', 'rehearsed', 'applied', 'already-applied'].includes(row.status)
              || (row.status === 'answered' && (row.questions == null || (Array.isArray(row.questions) && !row.questions.length)))) outstanding.delete(row.jobId);
          }
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
  if (snapshotAt !== undefined) {
    const represented = new Set<string>();
    for (const [key, feedback] of result) {
      const [jobId] = JSON.parse(key) as string[];
      represented.add(jobId);
      result.set(key, { ...feedback, unansweredQuestions: outstanding.get(jobId)?.questions ?? [] });
    }
    for (const [jobId, item] of outstanding) {
      if (!represented.has(jobId)) result.set(JSON.stringify([jobId, item.title, item.company]), { at: item.at, status: 'needs-human', reason: item.reason, unansweredQuestions: item.questions });
    }
  }
  return result;
}

/** Owner-scoped observations about similarly named postings can disclose facts
 * another board omitted. They are evidence for the matching agent, never a
 * duplicate decision or an automatic rejection of a different vacancy. */
export function relatedReviewFeedback(job: Pick<JobListing, 'id' | 'title' | 'company'>, history = recentReviewFeedback()) {
  const normalise = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const title = normalise(job.title), company = normalise(job.company);
  if (!title || !company) return [];
  const related: Array<{jobId: string; title: string; company: string; at: string; status: string; reason: string}> = [];
  for (const [key, outcome] of history) {
    const [jobId, previousTitle, previousCompany] = JSON.parse(key) as string[];
    if (jobId === job.id || normalise(previousTitle) !== title || normalise(previousCompany) !== company) continue;
    related.push({jobId, title: previousTitle, company: previousCompany, at: outcome.at, status: outcome.status, reason: outcome.reason});
  }
  return related.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 3);
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
