import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import type { AppliedRecord, ApplyOutcome } from './types.js';

const APPLIED = resolve(config.dataDir, 'applied.json');
const LOG = resolve(config.dataDir, 'run-log.jsonl');

function ensureDir() {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
}

export function loadApplied(): AppliedRecord[] {
  ensureDir();
  if (!existsSync(APPLIED)) return [];
  try {
    return JSON.parse(readFileSync(APPLIED, 'utf8')) as AppliedRecord[];
  } catch {
    return [];
  }
}

export function saveApplied(records: AppliedRecord[]) {
  ensureDir();
  writeFileSync(APPLIED, JSON.stringify(records, null, 2));
}

/** company+title+location, normalised — matches the dedupe rule in seek.md. */
export function dedupeKey(company: string, title: string, location: string): string {
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

  appliedToday(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.records.filter((r) => r.appliedAt.startsWith(today)).length;
  }

  get all(): AppliedRecord[] {
    return this.records;
  }
}

export function logOutcome(outcome: ApplyOutcome & { title?: string; company?: string }) {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...outcome });
  writeFileSync(LOG, line + '\n', { flag: 'a' });
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
    });
    added++;
  }
  return added;
}
