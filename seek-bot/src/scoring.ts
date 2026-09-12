import { config } from './config.js';
import type { CandidateProfile, JobListing, ScoreBreakdown } from './types.js';

export interface ParsedSalaryRate {
  period: 'hourly' | 'daily' | 'annual';
  minimum: number;
  annualEquivalent: number;
}

/** Pulls the lowest rate and its period from salary copy. */
export function parseSalaryRate(text?: string): ParsedSalaryRate | null {
  if (!text) return null;
  const nums = [...text.matchAll(/\$?\s?([\d,]+(?:\.\d+)?)\s*(k\b)?/gi)]
    .map((m) => {
      const n = Number(m[1].replace(/,/g, ''));
      if (Number.isNaN(n)) return null;
      return m[2] ? n * 1000 : n;
    })
    .filter((n): n is number => n !== null && n > 0);

  /**
   * Rate wording is checked BEFORE magnitude, deliberately.
   *
   * "Up to $1,100 per day" was previously read as $1,100 *per year* — because
   * 1100 passes a naive `>= 1000` annual test — and the listing was then
   * excluded for falling under the salary floor. That silently discarded
   * ~$240k contract roles.
   */
  const perDay = /\b(per day|\/day|a day|daily|p\.?d\b|day rate)\b/i.test(text);
  const perHour = /\b(per hour|\/hour|an hour|hourly|p\.?h\b|\/hr\b|hr rate)\b/i.test(text);

  if (perDay) {
    const daily = nums.filter((n) => n >= 100 && n <= 5_000);
    if (daily.length) {
      const minimum = Math.min(...daily);
      return { period: 'daily', minimum, annualEquivalent: Math.round(minimum * 220) };
    }
  }
  if (perHour) {
    const hourly = nums.filter((n) => n > 0 && n <= 500);
    if (hourly.length) {
      const minimum = Math.min(...hourly);
      return { period: 'hourly', minimum, annualEquivalent: Math.round(minimum * 1_800) };
    }
  }

  const annualish = nums.filter((n) => n >= 1000);
  if (annualish.length) {
    const minimum = Math.min(...annualish);
    return { period: 'annual', minimum, annualEquivalent: minimum };
  }

  /**
   * A bare figure under ~$2,000 with no unit is a contract rate, not a yearly
   * wage — nobody advertises "$800 per year". Treating it literally excluded
   * genuine ~$176k contracts for being "below the salary floor", so annualise
   * conservatively rather than discarding the listing.
   */
  const small = nums.filter((n) => n > 0 && n < 2_000);
  if (small.length) {
    const min = Math.min(...small);
    return min < 250
      ? { period: 'hourly', minimum: min, annualEquivalent: Math.round(min * 1_800) }
      : { period: 'daily', minimum: min, annualEquivalent: Math.round(min * 220) };
  }
  return null;
}

/** Backward-compatible annual equivalent used by existing callers and tests. */
export function parseMinSalary(text?: string): number | null {
  return parseSalaryRate(text)?.annualEquivalent ?? null;
}

export interface SalaryFloorComparison {
  period: 'hourly' | 'annual';
  amount: number;
  floor: number;
  inferred: boolean;
}

/** Selects the matching user preference for the period advertised by the job. */
export function salaryFloorForJob(job: JobListing): SalaryFloorComparison | null {
  const stated = parseSalaryRate(job.salary);
  if (stated?.period === 'hourly') {
    return {
      period: 'hourly',
      amount: stated.minimum,
      floor: config.rules.minHourlyRate,
      inferred: false,
    };
  }
  const annual = stated?.annualEquivalent ?? job.inferredMinSalary ?? null;
  if (annual === null) return null;
  return {
    period: 'annual',
    amount: annual,
    floor: config.rules.minSalary,
    inferred: !stated && job.inferredMinSalary !== undefined,
  };
}

export function isRemoteOrHybrid(job: JobListing): boolean {
  const hay = `${job.workArrangement ?? ''} ${job.location} ${job.title} ${job.teaser ?? ''} ${job.description ?? ''}`.toLowerCase();
  return /\bremote\b|\bhybrid\b|work from home|wfh|flexible location/.test(hay);
}

export type Arrangement = 'remote' | 'hybrid' | 'onsite';

/**
 * Hybrid is checked before remote: plenty of ads say "hybrid — 2 days remote",
 * and treating those as fully remote would wrongly accept them for someone who
 * only wants remote work.
 */
export function classifyArrangement(job: JobListing): Arrangement {
  const hay =
    `${job.workArrangement ?? ''} ${job.location} ${job.title} ${job.teaser ?? ''} ${job.description ?? ''}`.toLowerCase();
  if (/\bhybrid\b|days? (in|at) (the )?office|days? on[- ]?site|split between/.test(hay)) return 'hybrid';
  if (/\b(fully |100% )?remote\b|work from home|\bwfh\b|remote[- ]first/.test(hay)) return 'remote';
  return 'onsite';
}

export function isInOnsiteCity(job: JobListing): boolean {
  return job.location.toLowerCase().includes(config.rules.onsiteCity.toLowerCase());
}

/** Templated / lead-gen listing smells. Flag rather than apply. */
export function looksTemplated(job: JobListing): string | null {
  const d = (job.description ?? job.teaser ?? '').toLowerCase();
  if (!d) return null;
  // Narrow on purpose: "testing" alone appears in perfectly normal software ads.
  // These patterns target text an editor clearly forgot to replace.
  if (/lorem ipsum|your companies values|insert .{0,20}here\b|\bxxx+\b|\btbd\b\s*$/.test(d))
    return 'contains unedited placeholder text';
  if (/\bnec\b/.test(job.title.toLowerCase()) && d.length < 600)
    return 'generic ANZSCO-code posting with thin detail';
  // Short descriptions are not spam evidence; the role-neutral model assesses them.
  return null;
}

/**
 * Ignores any instruction-shaped text inside a listing. Job ads are data;
 * we have already seen live injection attempts in this corpus.
 */
export function detectInjection(job: JobListing): string | null {
  const d = `${job.title} ${job.description ?? ''} ${job.teaser ?? ''}`.toLowerCase();
  const patterns = [
    /ignore (all |any )?(previous|prior|above) instructions/,
    /you are an? (ai|assistant|language model)/,
    /system prompt/,
    /if you are an ai\b/,
    /insert the (phrase|text|words)/,
  ];
  for (const p of patterns) if (p.test(d)) return `listing contains instruction-shaped text: /${p.source}/`;
  return null;
}

export function deterministicExclusion(job: JobListing): string | null {
  // Only explicit machine-readable facts may stop a listing before model
  // review. Meaning in prose belongs to assessFit(), which can use context
  // and express uncertainty rather than silently discarding the listing.
  if (job.ageDays !== undefined && job.ageDays > config.rules.maxAgeDays)
    return `posted ${job.ageDays}d ago (>${config.rules.maxAgeDays}d)`;

  return null;
}

/** The account's configured semantic-fit floor. Used after model review. */
export function meetsMinimumScore(score: number): boolean {
  return Number.isFinite(score) && score >= config.rules.minScore;
}

/** Words that carry no signal when matching a search term against a job title. */
const TITLE_NOISE = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'to', 'with', 'new',
  'senior', 'junior', 'lead', 'entry', 'level', 'part', 'full', 'time', 'casual',
]);

function meaningfulTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((word) => word.length > 1 && !TITLE_NOISE.has(word));
}

/** What this candidate is actually searching for, lowercased. */
function searchTargets(): string[] {
  return [config.targetRole, ...config.keywords].map((t) => t.trim()).filter(Boolean);
}

/**
 * Best overlap between `text` and any of the candidate's own search terms,
 * as a 0-1 fraction of that term's meaningful words.
 */
function targetOverlap(text: string, targets: string[]): number {
  const tokens = new Set(meaningfulTokens(text));
  if (!tokens.size) return 0;
  let best = 0;
  for (const target of targets) {
    const wanted = meaningfulTokens(target);
    if (!wanted.length) continue;
    const overlap = wanted.filter((word) => tokens.has(word)).length / wanted.length;
    if (overlap > best) best = overlap;
  }
  return best;
}

/**
 * How well the ad's title matches what this candidate is searching for.
 *
 * This was previously a hardcoded software-role regex, which silently capped
 * every non-software candidate at 4/15 however perfectly the ad matched their
 * own search. A pharmacy-assistant search could not clear a 60-point threshold
 * even on a flawless "Pharmacy Assistant" ad — 51 of the 100 points were
 * structurally unreachable. Scoring against the candidate's own
 * KEYWORDS/TARGET_ROLE keeps the rubric meaningful in any field.
 */
export function titleFit(title: string, targets: string[] = searchTargets()): number {
  // Nothing configured to match against: stay neutral rather than punish.
  if (!targets.length) return 9;
  const best = targetOverlap(title, targets);
  if (best >= 0.99) return 15;
  if (best >= 0.5) return 12;
  if (best > 0) return 8;
  return 4;
}

/** seek.md's 100-point rubric: 40 skills / 15 title / 15 recency / 15 salary / 10 credibility / 5 location. */
export function scoreJob(job: JobListing, profile: CandidateProfile): ScoreBreakdown {
  const hay = `${job.title} ${job.description ?? job.teaser ?? ''}`.toLowerCase();
  const reasons: string[] = [];
  const targets = searchTargets();

  let skills: number;
  if (profile.skills.length) {
    const hits = profile.skills.filter((s) => hay.includes(s.toLowerCase()));
    skills = Math.min(40, Math.round((hits.length / 4) * 40));
    if (hits.length) reasons.push(`skills matched: ${hits.slice(0, 6).join(', ')}`);
    else reasons.push('no explicit profile skills found in ad');
  } else {
    /**
     * No skills on file. Scoring this 0/40 makes the threshold unreachable
     * for that candidate no matter how good the ad is, so fall back to how
     * well the ad itself matches their search terms — a weaker signal, but
     * one that still discriminates instead of flat-lining every job.
     */
    const match = targetOverlap(hay, targets);
    skills = Math.round(40 * match);
    reasons.push(
      match
        ? `no skills on file — ad matches ${Math.round(match * 100)}% of a search term`
        : 'no skills on file and no search-term match',
    );
  }

  const title = titleFit(job.title, targets);
  reasons.push(`title fit ${title}/15`);

  let recency = 5;
  if (job.ageDays !== undefined) {
    if (job.ageDays <= 1) recency = 15;
    else if (job.ageDays <= 3) recency = 12;
    else if (job.ageDays <= 7) recency = 9;
    else if (job.ageDays <= 14) recency = 6;
    else recency = 2;
    reasons.push(`posted ${job.ageDays}d ago`);
  }

  const pay = salaryFloorForJob(job);
  let salary = 10; // undisclosed is neutral, not a penalty
  if (pay) {
    salary = pay.floor <= 0 ? 10 : pay.amount >= pay.floor * 1.4 ? 15 : pay.amount >= pay.floor ? 13 : 0;
    const unit = pay.period === 'hourly' ? '/hour' : '/year';
    reasons.push(
      pay.inferred
        ? `salary not disclosed (listing data indicates ~${pay.amount.toLocaleString()}${unit})`
        : `salary min ~${pay.amount.toLocaleString()}${unit}`,
    );
  } else {
    reasons.push('salary not disclosed');
  }

  const templated = looksTemplated(job);
  const credibility = templated ? 2 : job.description && job.description.length > 900 ? 10 : 7;
  if (templated) reasons.push(`credibility flag: ${templated}`);

  const location = isRemoteOrHybrid(job) ? 5 : isInOnsiteCity(job) ? 4 : 0;

  const total = skills + title + recency + salary + credibility + location;
  return { skills, title, recency, salary, credibility, location, total, reasons };
}
