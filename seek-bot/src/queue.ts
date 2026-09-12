/**
 * Builds the review queue.
 *
 *   npm run queue
 *
 * Discovers, scores and drafts — and stops there. It never opens an apply form
 * and never submits anything; the browser extension fills the form in the
 * user's own browser and the user clicks Submit.
 *
 * That split is the whole design: everything expensive and unattended happens
 * here against public listings with no logged-in session, so it can run at any
 * volume without touching anyone's account.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, loadProfile } from './config.js';
import { launchBrowser, closeBrowser, getPage, jitter } from './browser.js';
import { recommended, search, fetchJobDetail } from './discovery.js';
import { deterministicExclusion, detectInjection, meetsMinimumScore } from './scoring.js';
import { assessFit, coverLetterForJob, rankJobsForReview, reviewKey } from './llm.js';
import { AppliedIndex } from './store.js';
import { assertHumanizerHealthy } from './humanizer.js';
import type { JobListing } from './types.js';

export type QueueStatus = 'pending' | 'applied' | 'skipped';

export interface QueueItem {
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  applyUrl: string;
  salary?: string;
  workArrangement?: string;
  ageDays?: number;
  score: number;
  scoreReasons: string[];
  fitReason: string;
  coverLetter: string;
  source?: 'recommended' | 'search';
  /** Set when the extension reports a completed submission. */
  status: QueueStatus;
  addedAt: string;
  decidedAt?: string;
  skipReason?: string;
}

const QUEUE_PATH = resolve(config.dataDir, 'queue.json');

export function loadQueue(): QueueItem[] {
  if (!existsSync(QUEUE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_PATH, 'utf8')) as QueueItem[];
  } catch {
    return [];
  }
}

export function saveQueue(items: QueueItem[]) {
  writeFileSync(QUEUE_PATH, JSON.stringify(items, null, 2));
}

async function build() {
  const profile = loadProfile();
  if (!config.celeris.apiKey) throw new Error('The matching service is not configured.');
  if (config.coverLetter.mode === 'reuse' && !config.coverLetter.reusableText) {
    throw new Error('Cover-letter mode is set to reuse, but no reusable cover letter was provided.');
  }
  await assertHumanizerHealthy();
  console.log('AuthorMist humanizer OK.');

  const existing = loadQueue();
  const index = new AppliedIndex();
  const known = new Set(existing.map((i) => i.jobId));

  console.log(`Building review queue for ${profile.name}`);
  console.log(`${existing.length} already queued, ${index.all.length} already applied\n`);

  const ctx = await launchBrowser();
  const page = await getPage(ctx);
  const fresh: QueueItem[] = [];
  const pruned = new Set<string>();

  try {
    /**
     * Re-verify what is already queued before adding more.
     *
     * A queued job can be applied to at any time — by hand, on a phone, or in a
     * previous session — and nothing would tell us. Asking SEEK directly is the
     * only reliable way to keep the queue free of jobs already applied to.
     */
    const pending = existing.filter((i) => i.status === 'pending');
    if (pending.length) {
      console.log(`Re-checking ${pending.length} queued job(s) against SEEK…`);
      for (const item of pending) {
        const check = await fetchJobDetail(page, {
          id: item.jobId,
          title: item.title,
          company: item.company,
          location: item.location,
          url: item.url,
        } as JobListing);
        if (check.alreadyApplied) {
          item.status = 'applied';
          item.decidedAt = new Date().toISOString();
          pruned.add(item.jobId);
          console.log(`  ↩ ${item.title} @ ${item.company} — ${check.appliedNote}`);
          if (!index.has(item.jobId, item.company, item.title, item.location)) {
            index.add({
              jobId: item.jobId,
              title: item.title,
              company: item.company,
              location: item.location,
              url: item.url,
              appliedAt: new Date().toISOString(),
              score: item.score,
              platform: 'seek',
              scoreReasons: [check.appliedNote ?? 'detected on SEEK'],
            });
          }
        }
        await jitter(700, 1500);
      }
      console.log(`  ${pruned.size} already applied — removed from review\n`);
    }

    // ---- discovery (public listings only — no session needed) ----
    const seen = new Map<string, JobListing>();
    const recommendations = await recommended(page).catch(() => [] as JobListing[]);
    for (const job of recommendations) seen.set(job.id, job);
    console.log(`  SEEK Recommended -> ${recommendations.length} personalised jobs (priority)`);

    for (const kw of config.keywords) {
      let total = 0;
      for (let p = 1; p <= config.limits.pagesPerKeyword; p++) {
        const results = await search(page, kw, p);
        if (!results.length) break;
        total += results.length;
        for (const j of results) if (!seen.has(j.id)) seen.set(j.id, j);
        await jitter(config.limits.searchDelayMs, config.limits.searchDelayMs * 1.6);
        if (results.length < 20) break;
      }
      console.log(`  "${kw}" → ${total}`);
    }
    console.log(`\n${seen.size} unique listings discovered.`);

    const shortlist = [...seen.values()]
      .filter((j) => !known.has(j.id))
      .filter((j) => !index.has(j.id, j.company, j.title, j.location))
      .filter((j) => j.ageDays === undefined || j.ageDays <= config.rules.maxAgeDays);
    const reviewPriorities = await rankJobsForReview(shortlist, profile).catch((error) => {
      console.warn(`  ! semantic pre-ranking unavailable: ${(error as Error).message}`);
      return new Map<string, { priority: number; reason: string }>();
    });
    shortlist.sort((a, b) => {
      const sourcePriority = Number(b.source === 'recommended') - Number(a.source === 'recommended');
      return sourcePriority || (reviewPriorities.get(reviewKey(b))?.priority ?? 0) - (reviewPriorities.get(reviewKey(a))?.priority ?? 0);
    });

    console.log(`${shortlist.length} new to evaluate (pre-ranked).\n`);

    const skips = new Map<string, number>();
    const bump = (r: string) => skips.set(r, (skips.get(r) ?? 0) + 1);
    let evaluated = 0;

    for (const stub of shortlist) {
      if (evaluated >= config.limits.maxEvaluations) {
        console.log(`  … evaluation cap (${config.limits.maxEvaluations}) reached`);
        break;
      }
      evaluated++;

      const job = await fetchJobDetail(page, stub);
      await jitter(900, 2000);

      /**
       * SEEK's own marker is checked first and trusted over local history —
       * it is the only thing that knows about applications made by hand, on
       * another device, or before this tool existed. Recording it locally means
       * the next run filters the job out before spending a page load on it.
       */
      if (job.alreadyApplied) {
        console.log(`  ↩ ${job.title} @ ${job.company} — ${job.appliedNote ?? 'already applied'}`);
        bump('already applied on SEEK');
        index.add({
          jobId: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          url: job.url,
          appliedAt: new Date().toISOString(),
          score: 0,
          platform: 'seek',
          scoreReasons: [job.appliedNote ?? 'detected on SEEK'],
        });
        continue;
      }

      const injection = detectInjection(job);
      if (injection) {
        console.log(`  ⚠ ${job.company} — ${injection}`);
        bump('prompt injection');
        continue;
      }
      const excluded = deterministicExclusion(job);
      if (excluded) {
        bump(excluded.replace(/:.*/, '').trim());
        continue;
      }
      const fit = await assessFit(job, profile);
      if (fit.injectionSuspected) console.warn(`  ! injection-shaped text in ${job.company} — ignored`);
      if (!fit.shouldApply) {
        console.log(`  ✗ ${fit.matchScore} · ${job.title} @ ${job.company} — ${fit.reason.slice(0, 90)}`);
        bump('not a fit');
        continue;
      }
      if (!meetsMinimumScore(fit.matchScore)) {
        console.log(`  ✗ ${fit.matchScore} · ${job.title} @ ${job.company} — below minimum ${config.rules.minScore}`);
        bump('below minimum match score');
        continue;
      }
      const fitReason = fit.reason;

      // Draft the letter now so the reviewer has something to read, not a spinner.
      const coverLetter = await coverLetterForJob(job, profile);

      fresh.push({
        jobId: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
        applyUrl: `${config.seekBase}/job/${job.id}/apply`,
        salary: job.salary,
        workArrangement: job.workArrangement,
        ageDays: job.ageDays,
        score: fit.matchScore,
        scoreReasons: fit.evidence,
        fitReason,
        coverLetter,
        source: job.source,
        status: 'pending',
        addedAt: new Date().toISOString(),
      });
      console.log(
        `  ✓ ${fit.matchScore} · ${job.title} @ ${job.company} (${job.location})` +
          (job.strongApplicant ? ' · SEEK: strong applicant' : ''),
      );
    }

    if (skips.size) {
      console.log('\nFiltered out:');
      for (const [r, n] of [...skips].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(3)} × ${r}`);
      }
    }
  } finally {
    await closeBrowser(ctx);
  }

  const merged = [...existing, ...fresh].sort((a, b) => {
    const sourcePriority = Number(b.source === 'recommended') - Number(a.source === 'recommended');
    return sourcePriority || b.score - a.score;
  });
  saveQueue(merged);

  const stillPending = merged.filter((i) => i.status === 'pending').length;
  console.log(
    `\n=== ${fresh.length} added · ${pruned.size} pruned as already applied · ${stillPending} awaiting review ===`,
  );
  console.log('Open the dashboard → Queue to review and apply.');
}

// Only run when invoked directly, so the dashboard can import loadQueue/saveQueue.
if (process.argv[1] && process.argv[1].endsWith('queue.js')) {
  build().catch((e) => {
    console.error(`\nFatal: ${e.message}`);
    process.exit(1);
  });
}
