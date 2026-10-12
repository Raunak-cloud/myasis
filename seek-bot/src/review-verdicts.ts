import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import type { JobListing } from './types.js';
import type { PlatformId } from './platforms.js';

/**
 * The candidate's own calls on jobs the fit check skipped, from the
 * dashboard's Skipped view (exported per run as review-verdicts.json).
 *
 * The fit check skipped most of what it reviewed and the candidate never saw
 * a single one, so a judge too strict about, say, "5+ years required" could
 * only reinforce itself. A verdict is used two ways: a job the candidate says
 * they would have applied to is put back into the next run as their choice,
 * and every verdict is shown to the fit check as how this candidate weighs
 * requirements — context for its judgement, never a rule.
 */
export interface ReviewVerdict {
  jobId: string;
  title: string;
  company: string;
  url?: string;
  /** Why the fit check skipped it, as it said at the time. */
  skipReason: string;
  /** 'apply': the candidate would have applied. 'skip': the skip was the right call. */
  verdict: 'apply' | 'skip';
  /** The candidate's own words, when they gave any. */
  note?: string;
  /** A run found the listing gone, or tried it enough times: still context, no longer reopened. */
  closed?: boolean;
  at: string;
}

const FILE = () => resolve(config.dataDir, 'review-verdicts.json');

export function loadReviewVerdicts(): ReviewVerdict[] {
  try {
    if (!existsSync(FILE())) return [];
    const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is ReviewVerdict => Boolean(
      item && typeof item === 'object'
      && typeof (item as ReviewVerdict).jobId === 'string'
      && typeof (item as ReviewVerdict).title === 'string'
      && ((item as ReviewVerdict).verdict === 'apply' || (item as ReviewVerdict).verdict === 'skip'),
    ));
  } catch {
    return [];
  }
}

/** The board a listing address belongs to, or none this bot applies through. */
function boardOf(url: string): PlatformId | null {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)seek\.com\.au$/i.test(host)) return 'seek';
    if (/(^|\.)indeed\.com$/i.test(host)) return 'indeed';
  } catch { /* not an address */ }
  return null;
}

/**
 * Jobs the candidate said they would have applied to, as listings for this
 * run to open again. Their fit check is the candidate's own call; everything
 * else — already applied, scope, age, the board's own form — still applies.
 */
export function chosenListings(verdicts: ReviewVerdict[]): JobListing[] {
  return verdicts.flatMap((verdict) => {
    const platform = verdict.verdict === 'apply' && !verdict.closed && verdict.url ? boardOf(verdict.url) : null;
    if (!platform || !verdict.url) return [];
    return [{
      id: verdict.jobId,
      title: verdict.title,
      company: verdict.company,
      location: '',
      url: verdict.url,
      platform,
      source: 'chosen' as const,
    }];
  });
}

/**
 * The verdicts as a prompt block for the fit check, or nothing. Framed as
 * evidence of how this candidate reads requirements, so it calibrates the
 * judgement without overriding the candidate's written instructions or what
 * the law requires.
 */
export function verdictContext(verdicts: ReviewVerdict[]): string {
  const shown = verdicts.slice(0, 20);
  if (!shown.length) return '';
  const lines = shown.map((item) => {
    const call = item.verdict === 'apply' ? 'would have applied' : 'agreed it was right to skip';
    const note = item.note?.trim() ? ` In their words: "${item.note.trim().slice(0, 300)}"` : '';
    return `- "${item.title.slice(0, 120)}" at ${item.company.slice(0, 80)}. Skipped because: ${item.skipReason.slice(0, 400)} The candidate ${call}.${note}`;
  });
  return `THE CANDIDATE'S OWN CALLS ON EARLIER SKIPS (how they weigh requirements; judge this job on its own facts)
${lines.join('\n')}
Where the candidate would have applied, they read that kind of requirement less strictly than the skip did; where they agreed, the reading was right. Use this to calibrate how strictly you read requirements of the same kind. It never overrides the candidate's instructions above, a legal or licence requirement, or the honesty rules.`;
}
