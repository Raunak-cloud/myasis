import { config } from './config.js';
import type { CandidateProfile, JobListing, ScoreBreakdown } from './types.js';

/** Pulls the lowest dollar figure out of strings like "$120,000 - $140,000 + super". */
export function parseMinSalary(text?: string): number | null {
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
    if (daily.length) return Math.round(Math.min(...daily) * 220); // ~220 working days
  }
  if (perHour) {
    const hourly = nums.filter((n) => n > 0 && n <= 500);
    if (hourly.length) return Math.round(Math.min(...hourly) * 1_800); // ~1800 billable hours
  }

  const annualish = nums.filter((n) => n >= 1000);
  if (annualish.length) return Math.min(...annualish);

  /**
   * A bare figure under ~$2,000 with no unit is a contract rate, not a yearly
   * wage — nobody advertises "$800 per year". Treating it literally excluded
   * genuine ~$176k contracts for being "below the salary floor", so annualise
   * conservatively rather than discarding the listing.
   */
  const small = nums.filter((n) => n > 0 && n < 2_000);
  if (small.length) {
    const min = Math.min(...small);
    return Math.round(min < 250 ? min * 1_800 : min * 220); // hourly vs daily
  }
  return null;
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
  if (d.length < 350 && !/react|node|javascript|typescript|python/i.test(d))
    return 'very short ad naming no concrete technology';
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

export function hardExclusions(job: JobListing, profile: CandidateProfile): string | null {
  const hay = `${job.title} ${job.description ?? job.teaser ?? ''}`.toLowerCase();

  for (const domain of profile.excludedDomains) {
    const key = domain.split(/\s|\//)[0].toLowerCase().replace(/[^a-z#.]/g, '');
    if (!key) continue;
    const core = new RegExp(
      `(${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[^.]{0,80}(required|must have|essential|core stack|strong|expert|\\d\\+ years)`,
      'i',
    );
    if (core.test(hay)) return `excluded domain: ${domain}`;
  }

  if (/\b(blockchain|crypto|web3|smart contract)\b/.test(hay)) return 'excluded domain: blockchain/crypto';
  if (/\b(cobol|mainframe)\b/.test(hay)) return 'excluded domain: mainframe/COBOL';

  // Work-arrangement rule. On-site is additionally pinned to the nominated
  // city; remote and hybrid are accepted anywhere in the country.
  const allowed = config.rules.workArrangements;
  const arrangement = classifyArrangement(job);
  if (allowed.length && !allowed.includes(arrangement))
    return `${arrangement} role, but only ${allowed.join('/')} selected`;
  if (arrangement === 'onsite' && !isInOnsiteCity(job))
    return `on-site role outside ${config.rules.onsiteCity}`;

  if (config.rules.jobTypes.length) {
    const hay = `${job.workArrangement ?? ''} ${job.title} ${job.description ?? job.teaser ?? ''}`.toLowerCase();
    if (!config.rules.jobTypes.some((t) => hay.includes(t)))
      return `job type not in ${config.rules.jobTypes.join('/')}`;
  }

  // Salary rule: excludes only when we have a real figure — either stated on
  // the ad, or SEEK's structured range for ads that hid the display value.
  const min = parseMinSalary(job.salary) ?? job.inferredMinSalary ?? null;
  if (min !== null && min < config.rules.minSalary)
    return `minimum salary ${min.toLocaleString()} below ${config.rules.minSalary.toLocaleString()}`;

  if (job.ageDays !== undefined && job.ageDays > config.rules.maxAgeDays)
    return `posted ${job.ageDays}d ago (>${config.rules.maxAgeDays}d)`;

  return null;
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

  const stated = parseMinSalary(job.salary);
  const min = stated ?? job.inferredMinSalary ?? null;
  let salary = 10; // undisclosed is neutral, not a penalty
  if (min !== null) {
    salary = min >= config.rules.minSalary * 1.4 ? 15 : min >= config.rules.minSalary ? 13 : 0;
    reasons.push(
      stated !== null
        ? `salary min ~${min.toLocaleString()}`
        : `salary not disclosed (listing data indicates ~${min.toLocaleString()})`,
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
