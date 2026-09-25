import { measured, metric } from './pipeline.js';
import { pickResumeForJob } from './resume.js';
import { assessFit, coverLetterForJob, rankJobsForReview, reviewKey } from './llm.js';
import { config, loadProfile } from './config.js';
import {
  launchBrowser,
  closeBrowser,
  getPage,
  ensureSignedIn,
  ensureIndeedSignedIn,
  workingIn,
  jitter,
} from './browser.js';
import { judgePage, WALL_STATES } from './blocker.js';
import { recommended, search, fetchJobDetail } from './discovery.js';
import {
  recommended as recommendedIndeed,
  search as searchIndeed,
  fetchJobDetail as fetchJobDetailIndeed,
} from './discovery-indeed.js';
import { scoreJob, deterministicExclusion, detectInjection, meetsMinimumScore } from './scoring.js';
import { applyToIndeedJob } from './apply-indeed.js';
import { applyToJobWithAgent, type ApplyDeps } from './agent/apply-agent.js';
import { AppliedIndex, logOutcome, saveRunSummary, syncFromSeek } from './store.js';
import { assertHumanizerHealthy } from './humanizer.js';
import { enabledPlatforms, type PlatformId } from './platforms.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';
import type { Page } from 'patchright';
import { australianGovernmentDestination } from './site-policy.js';
import { outsideScope, runScope, SCOPE_LABEL, scopeSkipReason } from './run-scope.js';
import { REVIEW_TTL, ReviewCache, reviewCacheMetadata, reviewContextFingerprint } from './review-cache.js';
import { assertExternalJobUrl, guardExternalNavigations } from './external-url.js';
import { runDirectExternalApplication } from './direct-external.js';
import {
  DISCOVERY_PRIORITY_FLOOR,
  discoveryTarget as calculateDiscoveryTarget,
  nextLowYieldStreak,
  shouldStopDiscovery,
} from './discovery-policy.js';

const searchOnly = process.argv.includes('--search-only');
const doSync = process.argv.includes('--sync');

/**
 * One entry per platform with a real adapter. `main.ts` no longer talks to
 * SEEK directly — it loops over `enabledPlatforms(config.platforms)` and
 * dispatches through this table, so SEEK-only, Indeed-only, or both in one
 * pass all go through the same discover → filter → score → apply pipeline.
 * `pageSize` is only used to decide when a search has run out of results.
 */
interface PlatformAdapter {
  id: PlatformId;
  label: string;
  pageSize: number;
  assertSignedIn: (page: Page) => Promise<void>;
  recommended: (page: Page) => Promise<JobListing[]>;
  search: (page: Page, keywords: string, pageNum: number) => Promise<JobListing[]>;
  fetchJobDetail: (page: Page, job: JobListing) => Promise<JobListing>;
  apply: (page: Page, job: JobListing, profile: CandidateProfile, deps: ApplyDeps) => Promise<ApplyOutcome>;
}

const ADAPTERS = new Map<PlatformId, PlatformAdapter>([
  [
    'seek',
    {
      id: 'seek',
      label: 'SEEK',
      pageSize: 32,
      assertSignedIn: ensureSignedIn,
      recommended,
      search,
      fetchJobDetail,
      apply: applyToJobWithAgent,
    },
  ],
  [
    'indeed',
    {
      id: 'indeed',
      label: 'Indeed',
      pageSize: 10,
      assertSignedIn: ensureIndeedSignedIn,
      recommended: recommendedIndeed,
      search: searchIndeed,
      fetchJobDetail: fetchJobDetailIndeed,
      apply: applyToIndeedJob,
    },
  ],
]);

async function main() {
  const startedAt = performance.now();
  const profile = loadProfile();
  const directExternalUrl = process.env.DIRECT_EXTERNAL_JOB_URL
    ? await assertExternalJobUrl(process.env.DIRECT_EXTERNAL_JOB_URL)
    : null;
  if (!directExternalUrl && !config.keywords.length && !config.targetRole) throw new Error('Set your job search terms or target role before running.');
  console.log(`Profile: ${profile.name} · ${profile.suburb ?? ''} · relocate=${profile.willingToRelocate}`);

  if (!config.celeris.apiKey && !searchOnly) {
    throw new Error('The matching service is not configured. Check the local environment settings.');
  }
  if (config.coverLetter.mode === 'reuse' && !config.coverLetter.reusableText) {
    throw new Error('Cover-letter mode is set to reuse, but no reusable cover letter was provided.');
  }
  if (!searchOnly) {
    if (!config.celeris.apiKey) {
      throw new Error('CELERIS_API_KEY is required — the browser agent drives every application.');
    }
    /**
     * Cover letters are the one call still on Gemini. Check the key up front:
     * discovering it is missing part-way through an application strands a
     * half-filled form on a real employer's site.
     */
    if (config.coverLetter.mode === 'tailored' && !config.gemini.apiKey) {
      throw new Error(
        'GEMINI_API_KEY is required for AI-tailored cover letters. Set it, or use COVER_LETTER_MODE=reuse.',
      );
    }
    console.log(
      `Browser agent: celeris-1-magnus (reasoning: low) ` +
        `(max ${config.celeris.maxSteps} steps, ${config.celeris.maxStepsPerPage} per page, $${config.celeris.budgetUsdPerApplication.toFixed(3)}/application)`,
    );
  }
  if (!searchOnly) {
    await assertHumanizerHealthy();
    console.log('AuthorMist humanizer OK.');
  }
  console.log(
    `Cover letters: ${config.coverLetter.mode === 'reuse' ? 'reuse the provided letter' : 'AI-tailored for every job'}`,
  );
  if (!config.celeris.apiKey) {
    console.warn(
      '\n⚠  Matching service unavailable — using keyword scoring only, with no stack-fit check.\n' +
        '   Scoring alone is lenient: it rates .NET/Dynamics roles highly off generic\n' +
        '   "developer" tokens. Treat this shortlist as unfiltered.\n',
    );
  }

  const index = new AppliedIndex();
  const reviewCache = new ReviewCache({
    // External listings are valid in a normal run, but known misses in a
    // hosted-only run. Normal runs still ignore this scoped suppression.
    allowExternalApply: config.allowExternalApply && runScope() !== 'hosted',
  });
  const reviewContext = reviewContextFingerprint(profile);
  const rememberExistingApplication = (job: JobListing, reason: string) => {
    if (index.has(job.id, job.company, job.title, job.location)) return;
    index.add({
      jobId: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
      appliedAt: new Date().toISOString(),
      score: 0,
      platform: job.platform ?? 'seek',
      scoreReasons: [reason],
      submittedByMyasis: false,
    });
  };
  const already = index.appliedToday();
  console.log(`Known applications: ${index.all.length} (${already} today)`);

  if (already >= config.limits.maxApplicationsPerDay) {
    console.log(`Daily cap of ${config.limits.maxApplicationsPerDay} already reached. Stopping.`);
    return;
  }

  const platforms = directExternalUrl ? [] : enabledPlatforms(config.platforms.join(','));
  console.log(directExternalUrl ? 'Run target: one direct employer website URL' : `Platforms this run: ${platforms.map((p) => p.label).join(', ')}`);
  if (process.env.BROWSER_ROUTE_NOTE) console.log(`Applying from: ${process.env.BROWSER_ROUTE_NOTE}`);
  // Boards the dashboard left out because the account is signed out of them.
  for (const board of (process.env.SKIPPED_BOARDS ?? '').split(',').map((b) => b.trim()).filter(Boolean)) {
    console.log(`⚠ ${board === 'indeed' ? 'Indeed' : 'SEEK'}: not signed in, so it was left out of this run.`);
  }
  if (runScope() !== 'all') console.log(`Scope: ${SCOPE_LABEL[runScope()]}`);

  const ctx = await launchBrowser();
  const directNavigation = directExternalUrl ? await guardExternalNavigations(ctx) : null;
  const page = await getPage(ctx);
  await workingIn(page);

  try {
    if (directExternalUrl) {
      await runDirectExternalApplication(page, directExternalUrl, profile, () => directNavigation?.blocked() ?? null);
      return;
    }
    // ---- per-platform sign-in + progressive discovery ---------------------
    // A sign-in failure or a stale session on one platform must not take the
    // other down with it — seek.md requires exactly this isolation.
    const seen = new Map<string, JobListing>();
    const shortlist: JobListing[] = [];
    const skips = new Map<string, number>();
    const reviewPriorities = new Map<string, { priority: number; reason: string }>();
    const active: PlatformAdapter[] = [];
    const targetedAdapters = new Set<PlatformId>();
    const bump = (reason: string) => skips.set(reason, (skips.get(reason) ?? 0) + 1);

    /** Keep enough backups for unavailable/already-applied listings. */
    const candidateCap = Math.max(12, config.limits.maxApplicationsPerRun * 3);
    const discoveryTarget = calculateDiscoveryTarget(config.limits.maxEvaluations, candidateCap);
    let rankingAvailable = Boolean(config.celeris.apiKey);

    /** Cheap checks run as each result page arrives, before more pages load. */
    const ingest = (jobs: JobListing[], adapter: PlatformAdapter): JobListing[] => {
      const accepted: JobListing[] = [];
      for (const raw of jobs) {
        const job = { ...raw, platform: raw.platform ?? adapter.id };
        const key = `${adapter.id}:${job.id}`;
        if (seen.has(key)) continue;
        seen.set(key, job);

        if (index.has(job.id, job.company, job.title, job.location)) continue;
        const prior = reviewCache.suppression(job, reviewContext);
        if (prior) {
          bump(`recent ${prior.disposition}`);
          continue;
        }
        if (australianGovernmentDestination(job)) {
          bump('Australian government application site');
          logOutcome({
            status: 'skipped', jobId: job.id, title: job.title, company: job.company,
            reason: 'Australian government application site excluded.',
            reviewCache: reviewCacheMetadata(job, 'policy', reviewContext, REVIEW_TTL.policy),
          });
          continue;
        }
        if (job.applicationMode === 'external' && !config.allowExternalApply) {
          bump('external application disabled');
          logOutcome({
            status: 'off-platform', jobId: job.id, title: job.title, company: job.company,
            redirectedTo: job.applicationUrl ?? 'employer site',
            reviewCache: reviewCacheMetadata(job, 'external', reviewContext, REVIEW_TTL.external),
          });
          continue;
        }
        if (job.applicationMode && job.applicationMode !== 'unknown' && outsideScope(job.applicationMode)) {
          bump('outside run scope');
          continue;
        }
        const excluded = deterministicExclusion(job);
        if (excluded) {
          bump(excluded.startsWith('excluded company:') ? 'excluded company' : 'listing age');
          console.log(`  – ${job.title} @ ${job.company} — ${excluded}`);
          logOutcome({ status: 'skipped', jobId: job.id, reason: excluded, title: job.title, company: job.company });
          continue;
        }
        shortlist.push(job);
        accepted.push(job);
      }
      return accepted;
    };

    /** Rank only the new batch; earlier batches stay in the combined queue. */
    const rankNew = async (jobs: JobListing[]): Promise<void> => {
      if (!jobs.length || !rankingAvailable) return;
      try {
        for (const [key, value] of await rankJobsForReview(jobs, profile)) reviewPriorities.set(key, value);
      } catch (error) {
        rankingAvailable = false;
        console.warn(`  ! semantic pre-ranking unavailable: ${(error as Error).message}`);
      }
    };
    const isPromising = (job: JobListing): boolean =>
      !rankingAvailable || (reviewPriorities.get(reviewKey(job))?.priority ?? 0) >= DISCOVERY_PRIORITY_FLOOR;
    const promisingCount = (): number => shortlist.filter(isPromising).length;

    // Sign in to every board and collect every recommendation feed first.
    const targeted: Array<{ job_id: string; title: string; company: string }> = JSON.parse(process.env.TARGET_SEEK_JOBS ?? '[]');
    const recommendedAccepted: JobListing[] = [];
    for (const platform of platforms) {
      const adapter = ADAPTERS.get(platform.id);
      if (!adapter) {
        console.warn(`  No adapter registered for ${platform.label} — skipping.`);
        continue;
      }
      try {
        await adapter.assertSignedIn(page);
        console.log(`${adapter.label} session OK.`);
      } catch (error) {
        console.log(`\n⚠ ${adapter.label}: ${(error as Error).message}`);
        console.log(`  Skipping ${adapter.label} for this run.${platforms.length > 1 ? ' Continuing with the other platform(s).' : ''}`);
        continue;
      }
      active.push(adapter);

      if (doSync && adapter.id === 'seek') {
        const added = await syncFromSeek(page);
        console.log(`Seeded ${added} existing applications from SEEK history.`);
      }

      if (targeted.length && adapter.id === 'seek') {
        targetedAdapters.add(adapter.id);
        const targetedJobs: JobListing[] = [];
        for (const target of targeted.slice(0, 10)) {
          const id = target.job_id;
          if (!/^\d{6,12}$/.test(id) || !target.title || !target.company) throw new Error('Invalid targeted job metadata.');
          targetedJobs.push(await adapter.fetchJobDetail(page, {
            id, title: target.title, company: target.company, location: '', platform: 'seek',
            url: `https://www.seek.com.au/job/${id}`,
          }));
        }
        recommendedAccepted.push(...ingest(targetedJobs, adapter));
        console.log(`  Targeted retry: ${targeted.length} listing(s); normal fit, scope and duplicate checks still apply.`);
        continue;
      }

      const recommendations = await adapter.recommended(page).catch((error) => {
        console.warn(`  ${adapter.label} Recommended could not be loaded: ${(error as Error).message}`);
        return [] as JobListing[];
      });
      recommendedAccepted.push(...ingest(recommendations, adapter));
      console.log(`  ${adapter.label} Recommended -> ${recommendations.length} personalised jobs (priority)`);
    }

    if (!active.length) {
      console.log('No enabled platform has a working session this run. Nothing to do — sign in and try again.');
      return;
    }
    await rankNew(recommendedAccepted);

    type SearchStream = {
      adapter: PlatformAdapter;
      keyword: string;
      total: number;
      pages: number;
      lowYieldPages: number;
      exhausted: boolean;
    };
    const terms = config.keywords.length ? config.keywords : [config.targetRole];
    const streams: SearchStream[] = active
      .filter((adapter) => !targetedAdapters.has(adapter.id))
      .flatMap((adapter) => terms.map((keyword) => ({
        adapter, keyword, total: 0, pages: 0, lowYieldPages: 0, exhausted: false,
      })));

    let stoppedEarly = shouldStopDiscovery({
      pageNumber: 0,
      maxPages: config.limits.pagesPerKeyword,
      promisingJobs: promisingCount(),
      target: discoveryTarget,
    });
    if (stoppedEarly) {
      console.log(
        `  Adaptive discovery stopped after recommendations: ` +
        `${promisingCount()} promising unseen listings fill this run's ${discoveryTarget} review slots.`,
      );
    }

    for (let pageNumber = 1; !stoppedEarly && pageNumber <= config.limits.pagesPerKeyword; pageNumber++) {
      const round: Array<{ stream: SearchStream; accepted: JobListing[] }> = [];
      for (const stream of streams) {
        if (stream.exhausted || stream.lowYieldPages >= 2) continue;
        const results = await measured(
          'discovery',
          () => stream.adapter.search(page, stream.keyword, pageNumber),
          { platform: stream.adapter.id },
        );
        stream.pages++;
        stream.total += results.length;
        const accepted = ingest(results, stream.adapter);
        round.push({ stream, accepted });
        if (!results.length || results.length < stream.adapter.pageSize) stream.exhausted = true;
        await jitter(config.limits.searchDelayMs, config.limits.searchDelayMs * 1.8);
      }

      const newlyAccepted = round.flatMap((item) => item.accepted);
      await rankNew(newlyAccepted);
      for (const { stream, accepted } of round) {
        stream.lowYieldPages = nextLowYieldStreak(
          stream.lowYieldPages,
          accepted.filter(isPromising).length,
        );
      }

      if (shouldStopDiscovery({
        pageNumber,
        maxPages: config.limits.pagesPerKeyword,
        promisingJobs: promisingCount(),
        target: discoveryTarget,
      })) {
        stoppedEarly = true;
        console.log(
          `  Adaptive discovery stopped after page ${pageNumber}: ` +
          `${promisingCount()} promising unseen listings fill this run's ${discoveryTarget} review slots.`,
        );
        break;
      }
      if (!round.length) break;
    }

    for (const stream of streams) {
      console.log(
        `  [${stream.adapter.label}] "${stream.keyword}" → ${stream.total} results` +
        (stream.pages > 1 ? ` (${stream.pages} pages)` : '') +
        (stream.lowYieldPages >= 2 ? ' · stopped after 2 low-yield pages' : ''),
      );
    }
    console.log(
      `\n${seen.size} unique listings discovered across ${active.length} platform(s)` +
      `${stoppedEarly ? ' (adaptive stop)' : ''}.`,
    );

    /** New batches were ranked as they arrived; sort the combined queue once. */
    const scopeRank = (job: JobListing): number => {
      if (runScope() === 'all') return 0;
      if (!job.applicationMode || job.applicationMode === 'unknown') return 1; // the board's panel will say
      return outsideScope(job.applicationMode) ? 2 : 0;
    };
    shortlist.sort((a, b) => {
      const scoped = scopeRank(a) - scopeRank(b);
      if (scoped) return scoped;
      return (reviewPriorities.get(reviewKey(b))?.priority ?? 0) - (reviewPriorities.get(reviewKey(a))?.priority ?? 0);
    });
    console.log(`${shortlist.length} after dedupe + age/company filters (pre-ranked).\n`);

    const candidates: Array<{ job: JobListing; score: number; why: string; reasons: string[] }> = [];
    const pendingFits: Array<{
      job: JobListing;
      score: number;
      scoreReasons: string[];
      adapter: PlatformAdapter;
      fitPromise: Promise<{
        fit?: Awaited<ReturnType<typeof assessFit>>;
        error?: string;
      }>;
    }> = [];
    /** Once a board presents a CAPTCHA, later detail pages would be the same wall. */
    const reviewBlockedPlatforms = new Set<PlatformId>();

    /**
     * Fit checks do not touch the browser, so a small batch can run while the
     * next detail pages are loading. The prompt and model stay identical; this
     * only removes idle network time. Batching is deliberately bounded to
     * avoid rate-limit bursts and preserve the pre-ranked result order.
     */
    const flushFits = async () => {
      if (!pendingFits.length) return;
      const decision = await Promise.race(pendingFits.map(async item => ({ item, ...(await item.fitPromise) })));
      pendingFits.splice(pendingFits.indexOf(decision.item), 1);
      const decisions = [decision];

      for (const { item, fit, error } of decisions) {
        if (candidates.length >= candidateCap) break;
        const { job, score, scoreReasons, adapter } = item;
        if (error) {
          console.warn(`  ! fit check failed for ${job.company}: ${error}`);
          logOutcome({
            status: 'error',
            jobId: job.id,
            error: `Fit check failed: ${error}`,
            title: job.title,
            company: job.company,
          });
          continue;
        }

        let why = scoreReasons.join('; ');
        let decisionReasons = scoreReasons;
        if (fit) {
          metric('fit-decision', 0, { jobId: job.id, decision: fit.decision });
          if (fit.injectionSuspected) console.warn(`  ! injection-shaped text in ${job.company} — ignored`);
          if (!fit.shouldApply) {
            console.log(`  ✗ ${score} · ${job.title} @ ${job.company} — ${fit.reason}`);
            bump(fit.decision === 'uncertain' ? 'fit needs clarification' : 'fit mismatch');
            logOutcome({
              status: 'skipped',
              jobId: job.id,
              reason: `Fit check (${fit.decision}): ${fit.reason}`,
              title: job.title,
              company: job.company,
              ...(fit.decision === 'skip' ? { reviewCache: reviewCacheMetadata(job, 'fit-mismatch', reviewContext, REVIEW_TTL.fit) } : {}),
            });
            continue;
          }
          if (!meetsMinimumScore(fit.matchScore)) {
            const reason = `Model match score ${fit.matchScore} below minimum ${config.rules.minScore}`;
            console.log(`  ✗ ${fit.matchScore} · ${job.title} @ ${job.company} — ${reason}`);
            bump('below minimum match score');
            logOutcome({ status: 'skipped', jobId: job.id, reason, title: job.title, company: job.company,
              reviewCache: reviewCacheMetadata(job, 'below-score', reviewContext, REVIEW_TTL.fit) });
            continue;
          }
          why = fit.reason;
          decisionReasons = fit.evidence;
        } else if (!meetsMinimumScore(score)) {
          bump('below minimum match score');
          continue;
        }

        const semanticScore = fit?.matchScore ?? score;
        candidates.push({
          job,
          score: semanticScore,
          why,
          reasons: decisionReasons,
        });
        console.log(
          `  ✓ ${semanticScore} · ${job.title} @ ${job.company} (${job.location}) [${adapter.label}]` +
            (job.source === 'recommended' ? ' · Recommended' : '') +
            (job.strongApplicant ? ' · SEEK: strong applicant' : ''),
        );
      }
    };

    let evaluated = 0;
    for (const stub of shortlist) {
      if (candidates.length >= candidateCap) break;
      const adapter = ADAPTERS.get(stub.platform ?? 'seek');
      if (!adapter || reviewBlockedPlatforms.has(adapter.id)) continue;
      if (stub.applicationMode && stub.applicationMode !== 'unknown' && outsideScope(stub.applicationMode)) {
        bump('outside run scope');
        continue;
      }
      let job = await measured('detail', () => adapter.fetchJobDetail(page, stub), { jobId: stub.id });

      // Resolve run scope as soon as the listing CTA is known. In particular,
      // do not make a page-judgement model call or simulate reading time for an
      // employer-site redirect in an Indeed-hosted-only run.
      if (job.applicationMode === 'external' && !config.allowExternalApply) {
        const destination = job.applicationUrl ?? 'employer site';
        console.log(`  ↪ off-platform (${destination}) — skipped before AI fit review`);
        bump('external application disabled');
        logOutcome({
          status: 'off-platform',
          jobId: job.id,
          redirectedTo: destination,
          title: job.title,
          company: job.company,
          reviewCache: reviewCacheMetadata(job, 'external', reviewContext, REVIEW_TTL.external),
        });
        continue;
      }

      if (job.applicationMode && job.applicationMode !== 'unknown' && outsideScope(job.applicationMode)) {
        bump('outside run scope');
        logOutcome({
          status: 'skipped', jobId: job.id, reason: scopeSkipReason(), title: job.title, company: job.company,
          ...(job.applicationMode === 'external'
            ? { reviewCache: reviewCacheMetadata(job, 'external', reviewContext, REVIEW_TTL.external) }
            : {}),
        });
        continue;
      }

      /**
       * Reading pace, not network pace. At 1–3 s a hundred job ads went by in
       * fifteen minutes, and Cloudflare challenges are partly rate-based — the
       * one that blocked a run appeared on a plain search page.
       */
      await jitter(5000, 8000);

      const governmentDestination = australianGovernmentDestination(job);
      if (governmentDestination) {
        console.log(`  â€“ ${job.title} @ ${job.company} â€” Australian government application site excluded before AI review`);
        bump('Australian government application site');
        logOutcome({
          status: 'skipped',
          jobId: job.id,
          reason: 'Australian government application site excluded.',
          title: job.title,
          company: job.company,
          reviewCache: reviewCacheMetadata(job, 'policy', reviewContext, REVIEW_TTL.policy),
        });
        continue;
      }

      const expected = `the ${adapter.label} job listing "${job.title}" at ${job.company}`;
      let verdict = await judgePage(page, expected);
      if (verdict.state === 'already-applied') {
        console.log(`  ↩ ${job.title} @ ${job.company} — ${verdict.reason}`);
        bump('already applied');
        rememberExistingApplication(job, verdict.reason);
        logOutcome({ status: 'already-applied', jobId: job.id, reason: verdict.reason, title: job.title, company: job.company });
        continue;
      }

      /**
       * The semantic page verdict above resolves work the account already
       * completed before fit review. For an unreadable listing it also tells
       * us whether a person is needed, the page is still loading, or the job
       * disappeared.
       */
      if (!job.description) {
        if (verdict.state === 'loading') {
          await jitter(3000, 5000);
          job = await measured('detail-retry', () => adapter.fetchJobDetail(page, stub), { jobId: stub.id });
          verdict = await judgePage(page, expected);
          if (verdict.state === 'already-applied') {
            console.log(`  ↩ ${job.title} @ ${job.company} — ${verdict.reason}`);
            bump('already applied');
            rememberExistingApplication(job, verdict.reason);
            logOutcome({ status: 'already-applied', jobId: job.id, reason: verdict.reason, title: job.title, company: job.company });
            continue;
          }
        }
        if (!job.description) {
          if (WALL_STATES.has(verdict.state)) {
            const reason = `${verdict.state === 'captcha' ? 'CAPTCHA' : verdict.state === 'login' ? 'Login wall' : 'Verification gate'} before AI fit review — ${verdict.reason}`;
            console.log(`  ↷ ${adapter.label} unavailable before fit review — no AI review was sent`);
            bump(reason);
            reviewBlockedPlatforms.add(adapter.id);
            logOutcome({ status: 'skipped', jobId: job.id, reason, title: job.title, company: job.company });
            continue;
          }
          console.log(`  ↷ ${job.title} @ ${job.company} — listing unavailable (${verdict.reason})`);
          bump('listing unavailable');
          logOutcome({ status: 'skipped', jobId: job.id, reason: `Listing unavailable: ${verdict.reason}`, title: job.title, company: job.company });
          continue;
        }
      }

      if (evaluated >= config.limits.maxEvaluations) {
        console.log(`  … evaluation cap (${config.limits.maxEvaluations}) reached`);
        break;
      }
      evaluated++;

      const injection = detectInjection(job);
      if (injection) {
        console.log(`  ⚠ ${job.company} — ${injection} (treated as data, listing skipped)`);
        logOutcome({ status: 'skipped', jobId: job.id, reason: injection, title: job.title, company: job.company });
        continue;
      }

      const excluded = deterministicExclusion(job);
      if (excluded) {
        bump(excluded.replace(/:.*/, '').trim());
        logOutcome({ status: 'skipped', jobId: job.id, reason: excluded, title: job.title, company: job.company });
        continue;
      }

      const heuristic = searchOnly ? scoreJob(job, profile) : null;
      const priority = reviewPriorities.get(reviewKey(job));
      const score = heuristic?.total ?? priority?.priority ?? 0;
      const scoreReasons = heuristic?.reasons ?? (priority?.reason ? [priority.reason] : []);
      const fitPromise = config.celeris.apiKey
        ? assessFit(job, profile).then(
            (fit) => ({ fit }),
            (error) => ({ error: (error as Error).message }),
          )
        : Promise.resolve({});
      pendingFits.push({ job, score, scoreReasons, adapter, fitPromise });
      if (pendingFits.length >= config.limits.fitConcurrency) await flushFits();
    }

    while (pendingFits.length) await flushFits();

    /**
     * Jobs the board hosts itself go first; the employer's own site is the
     * fallback for when those run out.
     *
     * Not a quality judgement — a hosted application is simply a far better
     * bet. It is one short known flow, it costs a fraction as much to complete,
     * and the résumé and profile are already attached. External sites are every
     * vendor's form at once: longer, slower, and where every failed application
     * in this run came from. With a run cap in play, spending it on hosted
     * listings first means more applications actually land.
     */
    const hostedFirst = (job: JobListing): number => (job.applicationMode === 'external' ? 1 : 0);

    candidates.sort((a, b) => {
      const hosted = hostedFirst(a.job) - hostedFirst(b.job);
      if (hosted) return hosted;
      const sourcePriority = Number(b.job.source === 'recommended') - Number(a.job.source === 'recommended');
      return sourcePriority || b.score - a.score;
    });

    const externalCount = candidates.filter((c) => hostedFirst(c.job) === 1).length;
    if (externalCount) {
      console.log(
        `\nOrder: ${candidates.length - externalCount} on-site application(s) first, ` +
          `then ${externalCount} on employer sites.`,
      );
    }

    if (skips.size) {
      console.log('\nFiltered out:');
      for (const [reason, n] of [...skips].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(3)} × ${reason}`);
      }
    }
    console.log(`\n${candidates.length} qualifying jobs.\n`);
    saveRunSummary(candidates.length);

    if (searchOnly) {
      console.table(
        candidates.map((c) => ({
          platform: c.job.platform ?? 'seek',
          score: c.score,
          title: c.job.title.slice(0, 40),
          company: c.job.company.slice(0, 28),
          location: c.job.location.slice(0, 24),
          age: c.job.ageDays,
          url: c.job.url,
        })),
      );
      return;
    }

    const prepare = (job: JobListing) => {
      // One candidate ahead only; these functions share their in-flight results.
      void coverLetterForJob(job, profile).catch(() => {});
      void pickResumeForJob(job, profile).catch(() => {});
    };
    // ---- apply -----------------------------------------------------------
    let applied = 0;
    let rehearsed = 0;
    /** Per-platform friction streaks — a wall on one board never stops the other. */
    const frictionStreak = new Map<PlatformId, number>();
    const abortedPlatforms = new Set<PlatformId>();

    /** Employer-site applications actually SUBMITTED today, across runs. Failures cost model calls but not allowance. */
    let externalSubmitted = config.limits.externalAttemptsToday;
    /** One attempt per role: SEEK lists the same job once per store or advertiser. */
    const attemptedRoles = new Set<string>();

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const { job, score, reasons } = candidates[candidateIndex];
      const platformId = job.platform ?? 'seek';
      const adapter = ADAPTERS.get(platformId);
      if (!adapter) continue;

      // A listing whose kind is already known and outside this run's scope is not attempted; an unknown one is left to the board's own panel to decide.
      if (job.applicationMode && job.applicationMode !== 'unknown' && outsideScope(job.applicationMode)) {
        logOutcome({ status: 'skipped', jobId: job.id, reason: scopeSkipReason(), title: job.title, company: job.company });
        continue;
      }

      const roleKey = `${job.title}|${job.company}`.toLowerCase().replace(/\s+/g, ' ').trim();
      if (attemptedRoles.has(roleKey)) {
        console.log(`  – skipped (same role already attempted this run): ${job.title} @ ${job.company}`);
        logOutcome({ status: 'skipped', jobId: job.id, reason: 'duplicate listing of a role already attempted this run', title: job.title, company: job.company });
        continue;
      }
      if (job.applicationMode === 'external') {
        if (externalSubmitted >= config.limits.maxExternalPerDay) {
          console.log(`  – skipped (daily limit of ${config.limits.maxExternalPerDay} employer-site applications reached): ${job.title} @ ${job.company}`);
          logOutcome({ status: 'skipped', jobId: job.id, reason: `daily limit of ${config.limits.maxExternalPerDay} employer-site applications reached`, title: job.title, company: job.company });
          continue;
        }
      }
      attemptedRoles.add(roleKey);

      if (abortedPlatforms.has(platformId)) {
        console.log(`  – skipped (${adapter.label} stopped earlier this run after repeated friction): ${job.title} @ ${job.company}`);
        continue;
      }

      const completed = config.dryRun && process.env.REHEARSE === 'true' ? rehearsed : applied;
      if (completed >= config.limits.maxApplicationsPerRun) {
        console.log(`\nRun cap of ${config.limits.maxApplicationsPerRun} reached.`);
        break;
      }
      if (index.appliedToday() >= config.limits.maxApplicationsPerDay) {
        console.log(`\nDaily cap of ${config.limits.maxApplicationsPerDay} reached.`);
        break;
      }

      console.log(`\n→ Applying: ${job.title} @ ${job.company}`);

      /**
       * A dead browser must not take the whole run's reporting with it. It is
       * unrecoverable (every later job would fail the same way), but the run
       * still has to say what it completed rather than dying with a stack
       * trace — and has to be explicit that this job was NOT submitted.
       */
      let outcome: ApplyOutcome;
      let candidateHitFriction = false;
      try {
        outcome = await measured('application', () => adapter.apply(page, job, profile, {
          onFriction: () => {
            candidateHitFriction = true;
            frictionStreak.set(platformId, (frictionStreak.get(platformId) ?? 0) + 1);
          },
        }), { jobId: job.id, platform: platformId });
      } catch (err) {
        const msg = (err as Error).message;
        if (/Target page, context or browser has been closed|browser has disconnected|Target closed/i.test(msg)) {
          console.log(
            `\n🛑 The browser closed mid-run — "${job.title} @ ${job.company}" was NOT submitted.\n` +
              `   Usual causes: the Chrome window was closed, another process killed it,\n` +
              `   or Stop was pressed. Nothing was sent for this job; earlier results below stand.`,
          );
          logOutcome({
            status: 'error',
            jobId: job.id,
            error: 'browser closed mid-run — not submitted',
            title: job.title,
            company: job.company,
          });
          break;
        }
        console.log(`  ✗ unexpected error: ${msg}`);
        logOutcome({ status: 'error', jobId: job.id, error: msg, title: job.title, company: job.company });
        continue;
      }
      logOutcome({ ...outcome, title: job.title, company: job.company });
      // Accounts, sign-ins and documents added are the candidate's business whatever the outcome.
      for (const action of outcome.actions ?? []) console.log(`  ℹ ${action.detail}`);
      if (outcome.submitPressed && outcome.status !== 'applied' && outcome.status !== 'rehearsed') {
        rememberExistingApplication(job, 'Submit was pressed on the employer form, so it may have been received; not retried automatically.');
        console.log('  ℹ submit was pressed on this form, so it will not be retried automatically');
      }

      switch (outcome.status) {
        case 'applied':
          applied++;
          if (job.applicationMode === 'external') externalSubmitted++;
          if (applied === 1) metric('first-submission', performance.now() - startedAt);
          frictionStreak.set(platformId, 0);
          index.add({
            jobId: job.id,
            title: job.title,
            company: job.company,
            location: job.location,
            url: job.url,
            appliedAt: outcome.at,
            score,
            platform: platformId,
            salary: job.salary,
            workArrangement: job.workArrangement,
            ageDaysAtApply: job.ageDays,
            coverLetter: outcome.coverLetter,
            answers: outcome.answers,
            scoreReasons: job.source === 'recommended' ? [`${adapter.label} Recommended`, ...reasons] : reasons,
            external: job.applicationMode === 'external',
            ...(outcome.site ? { site: outcome.site } : {}),
            ...(outcome.actions?.length ? { actions: outcome.actions } : {}),
            submittedByMyasis: true,
          });
          console.log(`  ✅ submitted${job.applicationMode === 'external' ? ' [external]' : ''} (${Number.isFinite(config.limits.maxApplicationsPerRun) ? `${applied}/${config.limits.maxApplicationsPerRun}` : applied})`);
          break;
        case 'rehearsed':
          rehearsed++;
          console.log(`  🧪 rehearsed — form completed, submit withheld (DRY_RUN)`);
          if (outcome.coverLetter) {
            console.log(`\n     ── cover letter ──\n${outcome.coverLetter.replace(/^/gm, '     ')}\n`);
          }
          for (const a of outcome.answers) {
            console.log(`     Q: ${a.question}\n     A: ${a.answer}`);
          }
          break;
        case 'off-platform':
          console.log(`  ↪ off-platform (${outcome.redirectedTo}) — skipped, nothing entered`);
          break;
        case 'already-applied':
          rememberExistingApplication(job, outcome.reason);
          console.log(`  ↩ already applied — ${outcome.reason}`);
          break;
        case 'needs-human':
          console.log(`  ⏸ needs you: ${outcome.reason}\n     ${outcome.url}`);
          break;
        case 'skipped':
          console.log(`  – skipped: ${outcome.reason}`);
          break;
        case 'error':
          console.log(`  ✗ error: ${outcome.error}`);
          break;
      }

      const streak = frictionStreak.get(platformId) ?? 0;
      if (streak >= config.limits.frictionAbortThreshold) {
        abortedPlatforms.add(platformId);
        console.log(
          `\n🛑 [${adapter.label}] ${streak} anti-bot challenges in a row. Stopping ${adapter.label} for this run — ` +
            `that account is being rate-limited.` +
            (active.length > abortedPlatforms.size
              ? ` Continuing with the other platform(s); let ${adapter.label} cool down before including it again.`
              : ' Let it cool down before running again.'),
        );
        if (abortedPlatforms.size >= active.length) break; // every active platform has hit the wall
      }

      const completedAfter = config.dryRun && process.env.REHEARSE === 'true' ? rehearsed : applied;
      if (completedAfter >= config.limits.maxApplicationsPerRun) {
        console.log(`\nRun cap of ${config.limits.maxApplicationsPerRun} reached.`);
        break;
      }
      // A cooldown only protects the next interaction. Do not make a finished
      // run wait another 25–70 seconds before reporting its result.
      if (candidateIndex < candidates.length - 1) {
        // Preserve full pacing after a submission or verification wall. An
        // attempt that sent nothing only needs a short, polite request gap.
        const nextCandidate = candidates.slice(candidateIndex + 1).find(c => !abortedPlatforms.has(c.job.platform ?? 'seek'));
        if (nextCandidate && !candidateHitFriction) prepare(nextCandidate.job);
        const fullCooldown = outcome.status === 'applied' || candidateHitFriction;
        await jitter(
          fullCooldown ? config.limits.minDelayMs : config.limits.minNonSubmitDelayMs,
          fullCooldown ? config.limits.maxDelayMs : config.limits.maxNonSubmitDelayMs,
        );
      }
    }

    console.log(`\n=== Run complete: ${applied} new application(s) ===`);
    console.log(`Log: data/run-log.jsonl · Store: data/applied.json`);
  } finally {
    metric('run-total', performance.now() - startedAt);
    await closeBrowser(ctx);
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
