import type { BrowserContext, Page } from 'patchright';
import { applyToJobWithAgent, type ApplyDeps } from './agent/apply-agent.js';
import { applyToEmployerJob } from './agent/apply-employer-job.js';
import { settleReviews } from './agent/lessons.js';
import { withApplicationAllowance } from './application-allowance.js';
import { applicationFailureContext } from './application-diagnostics.js';
import { applicationModelAvailable, applicationModelIdentity, assertApplicationBrowserConfigured } from './application-model.js';
import { applicationWorkerPage } from './application-worker-page.js';
import { ApplicationSlots, AsyncMutex, withApplicationWorker } from './application-workers.js';
import { applyToIndeedJob } from './apply-indeed.js';
import { judgePage, WALL_STATES } from './blocker.js';
import {
applicationWorkerContexts,
closeBrowser,
ensureIndeedSignedIn,
ensureSignedIn,
getPage,
jitter,
launchBrowser,
showLiveActivity,
workingIn,
} from './browser.js';
import { config, loadProfile } from './config.js';
import { runDirectExternalApplication } from './direct-external.js';
import {
fetchJobDetail as fetchJobDetailIndeed,
recommended as recommendedIndeed,
search as searchIndeed,
} from './discovery-indeed.js';
import {
discoveryTarget as calculateDiscoveryTarget,
DISCOVERY_PRIORITY_FLOOR,
nextLowYieldStreak,
shouldStopDiscovery,
} from './discovery-policy.js';
import { fetchJobDetail, recommended, search } from './discovery.js';
import { EMPLOYER_FEED_PAGE_SIZE, EmployerFeedDiscovery } from './employer-feeds.js';
import { EMPLOYER_SOURCES, employerFeedsEnabled } from './employer-source-config.js';
import { assertExternalJobUrl, guardExternalNavigations } from './external-url.js';
import { configureLiveWorkers, resetLiveWorkers } from './live-workers.js';
import { assessFit, rankJobsForReview, reviewKey, ruleConflict, type FitAssessment } from './llm.js';
import { SitePacer } from './pacing.js';
import { measured, metric } from './pipeline.js';
import { enabledPlatforms, type PlatformId } from './platforms.js';
import { REVIEW_TTL, ReviewCache, reviewCacheMetadata, reviewContextFingerprint } from './review-cache.js';
import { chosenListings, loadReviewVerdicts } from './review-verdicts.js';
import { countHealth } from './run-health.js';
import { outsideScope, runScope, SCOPE_LABEL, scopeSkipReason } from './run-scope.js';
import { deterministicExclusion, meetsMinimumScore, scoreJob } from './scoring.js';
import { SMARTRECRUITERS_PAGE_SIZE, SmartRecruitersDiscovery } from './smartrecruiters.js';
import { AppliedIndex, logOutcome, saveRunSummary, syncFromSeek } from './store.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';

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
  /** Public API discovery needs no sign-in or browser reading pause. */
  apiDiscovery?: boolean;
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

if (employerFeedsEnabled(process.env)) {
  const discovery = new SmartRecruitersDiscovery(process.env.SMARTRECRUITERS_COMPANIES || undefined, {
    warn: message => console.warn(`  ! ${message}`),
  });
  ADAPTERS.set('smartrecruiters', {
    id: 'smartrecruiters', label: 'SmartRecruiters', pageSize: SMARTRECRUITERS_PAGE_SIZE, apiDiscovery: true,
    assertSignedIn: async () => {}, recommended: async () => [],
    search: (_page, keyword, page) => discovery.search(keyword, page),
    fetchJobDetail: (_page, job) => discovery.detail(job),
    apply: async (page, job, profile, deps) => applyToEmployerJob(page, await discovery.detail(job), profile, deps),
  });
}

if (employerFeedsEnabled(process.env)) {
  for (const source of EMPLOYER_SOURCES) {
    if (source.id === 'smartrecruiters' || !config.platforms.includes(source.id)) continue;
    const discovery = new EmployerFeedDiscovery(source.id, process.env[source.key] || undefined, { warn: message => console.warn(`  ! ${message}`) });
    ADAPTERS.set(source.id, {
      id: source.id, label: source.label, pageSize: EMPLOYER_FEED_PAGE_SIZE, apiDiscovery: true,
      assertSignedIn: async () => {}, recommended: async () => [],
      search: (_page, keyword, page) => discovery.search(keyword, page),
      fetchJobDetail: (_page, job) => discovery.detail(job),
      apply: async (page, job, profile, deps) => applyToEmployerJob(page, await discovery.detail(job), profile, deps),
    });
  }
}

async function main() {
  const startedAt = performance.now();
  const profile = loadProfile();
  const directExternalUrl = process.env.DIRECT_EXTERNAL_JOB_URL
    ? await assertExternalJobUrl(process.env.DIRECT_EXTERNAL_JOB_URL)
    : null;
  if (!directExternalUrl && !config.keywords.length && !config.targetRole) throw new Error('Set your job search terms or target role before running.');
  console.log(`Profile: ${profile.name} · ${profile.suburb ?? ''} · relocate=${profile.willingToRelocate}`);

  if (!searchOnly) assertApplicationBrowserConfigured();
  if (config.coverLetter.mode === 'reuse' && !config.coverLetter.reusableText) {
    throw new Error('Cover-letter mode is set to reuse, but no reusable cover letter was provided.');
  }
  if (!searchOnly) {
    console.log(
      `Browser agent: ${applicationModelIdentity().model} ` +
        `(max ${config.celeris.maxSteps} steps, ${config.celeris.maxStepsPerPage} per page, $${config.celeris.budgetUsdPerApplication.toFixed(3)}/application)`,
    );
  }
  console.log(
    `Cover letters: ${config.coverLetter.mode === 'reuse' ? 'reuse the provided letter' : 'AI-tailored for every job'}`,
  );
  if (!applicationModelAvailable()) {
    console.warn(
      '\n⚠  Matching service unavailable — using keyword scoring only, with no stack-fit check.\n' +
        '   Scoring alone is lenient: it rates .NET/Dynamics roles highly off generic\n' +
        '   "developer" tokens. Treat this shortlist as unfiltered.\n',
    );
  }

  let index = new AppliedIndex();
  const reviewCache = new ReviewCache({
    // External listings are valid in a normal run, but known misses in a
    // hosted-only run. Normal runs still ignore this scoped suppression.
    allowExternalApply: config.allowExternalApply && runScope() !== 'hosted',
  });
  const reviewContext = reviewContextFingerprint(profile);
  const rememberExistingApplication = (job: JobListing, reason: string) => {
    if (index.hasApplication(job)) return;
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
  resetLiveWorkers(config.dataDir);
  const directNavigation = directExternalUrl ? await guardExternalNavigations(ctx) : null;
  let page = await getPage(ctx);
  await workingIn(page);

  try {
    if (directExternalUrl) {
      await runDirectExternalApplication(page, directExternalUrl, profile, () => directNavigation?.blocked() ?? null);
      return;
    }
    // ---- per-platform sign-in and discovery ---------------------
    // A sign-in failure or a stale session on one platform must not take the
    // other down with it — seek.md requires exactly this isolation.
    const seen = new Map<string, JobListing>();
    const shortlist: JobListing[] = [];
    const skips = new Map<string, number>();
    const reviewPriorities = new Map<string, { priority: number; reason: string }>();
    const active: PlatformAdapter[] = [];
    /** Each board's own polite gap between searches (seek-bot/src/pacing.ts). */
    const sitePacer = new SitePacer();
    const platformReads = new Map<PlatformId, AsyncMutex>();
    const readPlatform = <T>(platform: PlatformId, read: () => Promise<T>): Promise<T> => {
      let mutex = platformReads.get(platform);
      if (!mutex) platformReads.set(platform, mutex = new AsyncMutex());
      return mutex.run(read);
    };
    const targetedAdapters = new Set<PlatformId>();
    const bump = (reason: string) => skips.set(reason, (skips.get(reason) ?? 0) + 1);
    const skipExistingApplication = (job: JobListing): boolean => {
      if (!job.alreadyApplied && !index.hasApplication(job)) return false;
      const reason = job.appliedNote || 'An application to this role is already recorded.';
      if (job.alreadyApplied) rememberExistingApplication(job, reason);
      bump('already applied');
      console.log(`  – skipped (already applied): ${job.title} @ ${job.company}`);
      logOutcome({ status: 'already-applied', jobId: job.id, reason, title: job.title, company: job.company, url: job.url });
      return true;
    };
    /**
     * Boards whose security check could not be passed this run. One board's
     * wall used to end the whole run: an Indeed Cloudflare check that
     * CapMonster could not solve while searching was thrown all the way up as
     * "Fatal", so SEEK, signed in and working, never got its turn. A blocked
     * board is now dropped for the rest of the run and the others carry on.
     */
    const blockedPlatforms = new Set<PlatformId>();
    const isVerificationWall = (error: unknown) =>
      /VerificationBlocked/i.test((error as Error)?.name ?? '') || /security verification|captcha|cloudflare/i.test((error as Error)?.message ?? '');
    const blockPlatform = (adapter: PlatformAdapter, error: unknown) => {
      if (blockedPlatforms.has(adapter.id)) return;
      blockedPlatforms.add(adapter.id);
      console.log(`
⚠ ${adapter.label}: ${(error as Error).message} ${adapter.label} is left out for the rest of this run; the other board(s) carry on.`);
    };

    /** Keep enough backups for unavailable/already-applied listings. */
    const candidateCap = Math.max(12, config.limits.maxApplicationsPerRun * 3);
    const discoveryTarget = calculateDiscoveryTarget(config.limits.maxEvaluations, candidateCap);
    let rankingAvailable = applicationModelAvailable();

    /** Cheap checks run as each result page arrives, before more pages load. */
    const ingest = (jobs: JobListing[], adapter: PlatformAdapter): JobListing[] => {
      const accepted: JobListing[] = [];
      for (const raw of jobs) {
        const job = { ...raw, platform: raw.platform ?? adapter.id };
        const key = `${adapter.id}:${job.id}`;
        if (seen.has(key)) continue;
        seen.set(key, job);

        if (skipExistingApplication(job)) continue;

        // Waiting on the candidate (Needs attention): retrying cannot help until they answer.

        const prior = reviewCache.suppression(job, reviewContext);
        if (prior) {
          bump(`recent ${prior.disposition}`);
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
    /**
     * A listing already known to be outside this run's scope fills no slot:
     * an employer-sites-only run counted SEEK Quick Apply recommendations as
     * promising, stopped before any job-title search, and then filtered 123
     * of them out as "outside run scope", so new search terms were never searched.
     */
    const isPromising = (job: JobListing): boolean =>
      !(job.applicationMode && job.applicationMode !== 'unknown' && outsideScope(job.applicationMode))
      && (!rankingAvailable || (reviewPriorities.get(reviewKey(job))?.priority ?? 0) >= DISCOVERY_PRIORITY_FLOOR);
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
        console.log(adapter.apiDiscovery ? `${adapter.label} public job feed ready (admin only).` : `${adapter.label} session OK.`);
      } catch (error) {
        console.log(`\n⚠ ${adapter.label}: ${(error as Error).message}`);
        console.log(`  Skipping ${adapter.label} for this run.${platforms.length > 1 ? ' Continuing with the other platform(s).' : ''}`);
        continue;
      }
      active.push(adapter);

      if (doSync && adapter.id === 'seek') {
        const added = await syncFromSeek(page);
        index = new AppliedIndex();
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
        // A wall already up here would stand in front of every search and listing too.
        if (isVerificationWall(error)) blockPlatform(adapter, error);
        else console.warn(`  ${adapter.label} Recommended could not be loaded: ${(error as Error).message}`);
        return [] as JobListing[];
      });
      recommendedAccepted.push(...ingest(recommendations, adapter));
      console.log(`  ${adapter.label} Recommended -> ${recommendations.length} personalised jobs (priority)`);
    }

    if (!active.length) {
      console.log('No enabled platform has a working session this run. Nothing to do — sign in and try again.');
      return;
    }
    /**
     * Skipped jobs the candidate said they would have applied to (the
     * dashboard's Skipped view), opened again this run as their choice.
     * Everything but the fit check still applies on the way in and at the
     * form: already applied, scope, age, a security check, the board's form.
     */
    const chosen = chosenListings(loadReviewVerdicts());
    for (const adapter of active) {
      const mine = chosen.filter((job) => job.platform === adapter.id);
      if (!mine.length || targetedAdapters.has(adapter.id)) continue;
      const accepted = ingest(mine, adapter);
      recommendedAccepted.push(...accepted);
      if (accepted.length) console.log(`  ${adapter.label}: ${accepted.length} skipped job(s) you chose to apply to after all`);
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
    const searchAdapters = active.filter((adapter) => !targetedAdapters.has(adapter.id));
    // Boards take turns, so one board's polite gap is spent searching the other.
    const streams: SearchStream[] = terms.flatMap((keyword) => searchAdapters.map((adapter) => ({
      adapter, keyword, total: 0, pages: 0, lowYieldPages: 0, exhausted: false,
    })));

    /** Order of review: in-scope listings first, then the pre-ranking's priority. */
    const scopeRank = (job: JobListing): number => {
      if (runScope() === 'all') return 0;
      if (!job.applicationMode || job.applicationMode === 'unknown') return 1; // the board's panel will say
      return outsideScope(job.applicationMode) ? 2 : 0;
    };
    /**
     * Within scope, the boards' own recommendations are opened before search
     * results, as the run promises (Run panel, landing page): with the
     * evaluation cap a recommendation the pre-ranking scored low could
     * otherwise never be opened at all. Scope stays first — an out-of-scope
     * recommendation is dropped unopened anyway.
     */
    const recommendedFirst = (job: JobListing): number => (job.source === 'recommended' || job.source === 'chosen' ? 0 : 1);
    const reviewOrder = (a: JobListing, b: JobListing) => {
      const scoped = scopeRank(a) - scopeRank(b);
      if (scoped) return scoped;
      const recommended = recommendedFirst(a) - recommendedFirst(b);
      if (recommended) return recommended;
      return (reviewPriorities.get(reviewKey(b))?.priority ?? 0) - (reviewPriorities.get(reviewKey(a))?.priority ?? 0);
    };

    let nextPage = 1;
    const liveStreams = () => streams.filter((stream) => !stream.exhausted && stream.lowYieldPages < 2 && !blockedPlatforms.has(stream.adapter.id));
    /** Whether the job-title searches have pages they have not read yet. */
    const searchesLeft = () => nextPage <= config.limits.pagesPerKeyword && liveStreams().length > 0;
    const discoveryLeft = () => searchesLeft();
    /** Reads the next result page of every search still yielding. */
    const searchPageRound = async (): Promise<void> => {
      const pageNumber = nextPage++;
      const round: Array<{ stream: SearchStream; accepted: JobListing[] }> = [];
      for (const stream of liveStreams()) {
        // The round's list was taken before it started: a board walled earlier in this round is not asked again.
        if (blockedPlatforms.has(stream.adapter.id)) {
          stream.exhausted = true;
          continue;
        }
        let results: JobListing[];
        try {
          results = await readPlatform(stream.adapter.id, async () => {
            await sitePacer.ready(stream.adapter.id);
            try {
              return await measured(
                'discovery',
                () => stream.adapter.search(page, stream.keyword, pageNumber),
                { platform: stream.adapter.id },
              );
            } finally {
              sitePacer.done(stream.adapter.id, config.limits.searchDelayMs, config.limits.searchDelayMs * 1.8);
            }
          });
        } catch (error) {
          // A search that fails ends that search, not the run.
          stream.exhausted = true;
          if (isVerificationWall(error)) blockPlatform(stream.adapter, error);
          else console.warn(`  ! ${stream.adapter.label} search for "${stream.keyword}" failed: ${(error as Error).message}`);
          continue;
        }
        stream.pages++;
        stream.total += results.length;
        const accepted = ingest(results, stream.adapter);
        round.push({ stream, accepted });
        if (!results.length || results.length < stream.adapter.pageSize) stream.exhausted = true;
      }

      const newlyAccepted = round.flatMap((item) => item.accepted);
      await rankNew(newlyAccepted);
      for (const { stream, accepted } of round) {
        stream.lowYieldPages = nextLowYieldStreak(
          stream.lowYieldPages,
          accepted.filter(isPromising).length,
        );
      }
    };

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

    while (!stoppedEarly && searchesLeft()) {
      await searchPageRound();
      const pageNumber = nextPage - 1;
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
      }
    }

    for (const stream of [...streams].sort((a, b) => searchAdapters.indexOf(a.adapter) - searchAdapters.indexOf(b.adapter))) {
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
    shortlist.sort(reviewOrder);

    /**
     * An early stop is a bet, not a decision. When board recommendations
     * already fill the review slots the searches are skipped, and when those
     * recommendations then all fail review the run used to end with nothing to
     * apply for, its job-title searches never read (30 Sep: 28 "promising"
     * recommendations, 0 suitable, 0 applied). Once review has gone through
     * everything found, the searches carry on from the page they stopped at,
     * and only what is new is reviewed: listings already applied for, recently
     * rejected or already seen are dropped on the way in, as always.
     */
    let searchResumed = false;
    const searchMore = async (): Promise<void> => {
      if (!searchResumed) {
        searchResumed = true;
        console.log('\n  Suitable jobs ran short, so the job-title search continues.');
      }
      const before = shortlist.length;
      const pageNumber = nextPage;
      await searchPageRound();
      const added = shortlist.splice(before).sort(reviewOrder);
      shortlist.push(...added);
      console.log(`  Search page ${pageNumber}: ${added.length} new listing(s) to review.`);
    };
    // Only fallback discovery still owns the persistent search page. Recheck
    // the queue after acquiring it: another worker may already have refilled it.
    const discoveryMutex = new AsyncMutex();
    const refillReviews = () => discoveryMutex.run(async () => {

      if (!hasUnreviewed() && searchesLeft()) {
        await showLiveActivity({ phase: 'reviewing', detail: 'Finding more job listings.' }, page);
        try { await searchMore(); }
        finally { await showLiveActivity({ phase: 'waiting', detail: 'Looking for the next matching job.' }); }
      }
    });
    console.log(`${shortlist.length} after dedupe + age/company filters (pre-ranked).\n`);

    /**
     * Review and applying run as one pipeline rather than two phases.
     *
     * Applying used to wait until every listing had been opened and reviewed,
     * and each application was then followed by a 25–70 s pause doing nothing.
     * Measured over ten days that put the first submission ~7 minutes into a
     * run, and the pauses plus the reading time of listings made up about half
     * of all run time. Now the first job that qualifies is applied for as soon
     * as it is known, and the pause after each application is spent reading the
     * next listings — what a person does between applications anyway. The
     * pacing is unchanged: every listing still gets its reading pause and every
     * submission its full cooldown; they simply overlap.
     *
     * The same models make the same decisions. Only the order in which
     * qualified jobs are taken changes: best of those reviewed so far, rather
     * than best of all. The queue is pre-ranked and board recommendations come
     * first, so the best candidates are reviewed first, and the run cap is
     * rarely what ends a run (about 1.4 submissions per run over ten days).
     */
    const candidates: Array<{ job: JobListing; score: number; why: string; reasons: string[] }> = [];
    let busyWorkers = 0;
    const workWaiters = new Set<() => void>();
    const workChanged = () => { for (const resolve of workWaiters) resolve(); workWaiters.clear(); };
    /** Every job that qualified this run, applied for yet or not. */
    let qualified = 0;
    const pendingFits: Array<{
      job: JobListing;
      score: number;
      scoreReasons: string[];
      adapter: PlatformAdapter;
      settled: boolean;
      fitPromise: Promise<{
        fit?: Awaited<ReturnType<typeof assessFit>>;
        error?: string;
      }>;
    }> = [];
    /** Once a board presents a CAPTCHA, later detail pages would be the same wall. */
    const reviewBlockedPlatforms = blockedPlatforms;
    /** Per-platform friction streaks — a wall on one board never stops the other. */
    const frictionStreak = new Map<PlatformId, number>();
    const abortedPlatforms = new Set<PlatformId>();
    /** A board stopped for this run: walled during search or review, or rate-limited while applying. */
    const stoppedPlatform = (platform: PlatformId) => blockedPlatforms.has(platform) || abortedPlatforms.has(platform);

    /** Turns one finished fit check into a candidate, or a logged skip. */
    const settleFit = (item: (typeof pendingFits)[number], { fit, error }: { fit?: Awaited<ReturnType<typeof assessFit>>; error?: string }) => {
      const position = pendingFits.indexOf(item);
      // Concurrent reviewers can await the same finished model call. Consume
      // it exactly once; splice(-1) would otherwise remove an unrelated check.
      if (position < 0) return;
      pendingFits.splice(position, 1);
      workChanged();
      if (qualified >= candidateCap) return;
      const { job, score, scoreReasons, adapter } = item;
      if (skipExistingApplication(job)) {
        restoreReviewSlot(job, false);
        return;
      }
      if (error) {
        restoreReviewSlot(job, false);
        console.warn(`  ! fit check failed for ${job.company}: ${error}`);
        logOutcome({
          status: 'error',
          jobId: job.id,
          error: `Fit check failed: ${error}`,
          title: job.title,
          company: job.company,
        });
        return;
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
            // The Skipped view links each one, so the candidate can read the listing the check read.
            url: job.url,
            ...(fit.decision === 'skip' ? { reviewCache: reviewCacheMetadata(job, 'fit-mismatch', reviewContext, REVIEW_TTL.fit) } : {}),
          });
          return;
        }
        if (!meetsMinimumScore(fit.matchScore)) {
          const reason = `Model match score ${fit.matchScore} below minimum ${config.rules.minScore}`;
          console.log(`  ✗ ${fit.matchScore} · ${job.title} @ ${job.company} — ${reason}`);
          bump('below minimum match score');
          logOutcome({ status: 'skipped', jobId: job.id, reason, title: job.title, company: job.company, url: job.url,
            reviewCache: reviewCacheMetadata(job, 'below-score', reviewContext, REVIEW_TTL.fit) });
          return;
        }
        why = fit.reason;
        decisionReasons = fit.evidence;
      } else if (!meetsMinimumScore(score)) {
        bump('below minimum match score');
        return;
      }

      const semanticScore = fit?.matchScore ?? score;
      candidates.push({ job, score: semanticScore, why, reasons: decisionReasons });
      workChanged();
      qualified++;
      console.log(
        `  ✓ ${semanticScore} · ${job.title} @ ${job.company} (${job.location}) [${adapter.label}]` +
          (job.source === 'recommended' ? ' · Recommended' : '') +
          (job.strongApplicant ? ' · SEEK: strong applicant' : ''),
      );
    };

    /** Settles every fit check that has already answered, without waiting on any. */
    const settleAnswered = async () => {
      for (const item of pendingFits.filter((candidate) => candidate.settled)) settleFit(item, await item.fitPromise);
    };

    /**
     * Fit checks do not touch the browser, so a few run while the next detail
     * pages load. Waits for the first to answer; bounded so a burst cannot
     * trip rate limits.
     */
    const flushFits = async () => {
      if (!pendingFits.length) return;
      const decision = await Promise.race(pendingFits.map(async (item) => ({ item, result: await item.fitPromise })));
      settleFit(decision.item, decision.result);
    };

    const reviewClaimed = new Set<string>();
    const hasUnreviewed = (accept: (job: JobListing) => boolean = () => true) =>
      shortlist.some(job => !reviewClaimed.has(reviewReservationKey(job)) && accept(job));
    let evaluated = 0;
    let reviewStopped = false;
    let workersRemaining = 1;
    const activeReviews = new Set<Promise<void>>();
    const reviewReservations = new Set<string>();
    const reviewReservationKey = (job: JobListing) => `${job.platform ?? 'seek'}:${job.id}`;
    /** Unusable reviews and late duplicate discoveries must leave room for another new job. */
    const restoreReviewSlot = (job: JobListing, completed: boolean) => {
      if (!reviewReservations.delete(reviewReservationKey(job))) return;
      evaluated--;
      if (completed) {
        qualified--;
        console.log(`  Review slot restored: ${job.title} @ ${job.company}`);
      }
      if (qualified < candidateCap && evaluated < config.limits.maxEvaluations) reviewStopped = false;
      workChanged();
    };
    const reviewDone = () => reviewStopped || (!hasUnreviewed() && !discoveryLeft());
    /** Nothing left to review and no fit check still out. */
    const reviewExhausted = () => reviewDone() && !pendingFits.length && !activeReviews.size;

    /** Reviews the next listing in the pre-ranked queue. */
    const jobLabel = (job: JobListing) => `${job.title} @ ${job.company}`;
    const reviewNext = async (reviewPage: Page, accept: (job: JobListing) => boolean): Promise<void> => {
      if (reviewDone()) return;
      if (qualified >= candidateCap) {
        reviewStopped = true;
        return;
      }
      // Checked before the listing is opened: the job that trips the cap no longer pays for a page load first.
      if (evaluated >= config.limits.maxEvaluations) {
        console.log(`  … evaluation cap (${config.limits.maxEvaluations}) reached`);
        reviewStopped = true;
        return;
      }
      const stub = shortlist.find(job => !reviewClaimed.has(reviewReservationKey(job)) && accept(job));
      if (!stub) {
        await refillReviews();
        return;
      }
      reviewClaimed.add(reviewReservationKey(stub));
      const adapter = ADAPTERS.get(stub.platform ?? 'seek');
      if (!adapter || reviewBlockedPlatforms.has(adapter.id) || abortedPlatforms.has(adapter.id)) return;
      // History may have changed since discovery while another application was sent.
      if (skipExistingApplication(stub)) return;
      if (stub.applicationMode && stub.applicationMode !== 'unknown' && outsideScope(stub.applicationMode)) {
        bump('outside run scope');
        return;
      }
      // Claim capacity before the first await. Page reads now overlap, but the
      // evaluation allowance remains one run-wide budget. Unusable reads return
      // their reservation in finally, including navigation failures and walls.
      evaluated++;
      reviewReservations.add(reviewReservationKey(stub));
      let retained = false;
      try {
        await readPlatform(adapter.id, async () => {
          let job: JobListing;
          // A search just made on this board still has its gap to run out.
          await sitePacer.ready(adapter.id);
          try {
            job = await measured('detail', () => adapter.fetchJobDetail(reviewPage, stub), { jobId: stub.id });
          } catch (error) {
            if (isVerificationWall(error)) blockPlatform(adapter, error);
            else console.warn(`  ! ${jobLabel(stub)}: the listing could not be opened (${(error as Error).message})`);
            return;
          }

          // Board history includes applications made by hand or on another device.
          // Check it before reading pauses and fit/model calls; an early return
          // gives the temporary evaluation reservation back to the run.
          if (skipExistingApplication(job)) return;

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
            return;
          }

          if (job.applicationMode && job.applicationMode !== 'unknown' && outsideScope(job.applicationMode)) {
            bump('outside run scope');
            logOutcome({
              status: 'skipped', jobId: job.id, reason: scopeSkipReason(), title: job.title, company: job.company,
              ...(job.applicationMode === 'external'
                ? { reviewCache: reviewCacheMetadata(job, 'external', reviewContext, REVIEW_TTL.external) }
                : {}),
            });
            return;
          }

          /**
           * Posting age and excluded employers are facts the listing states, so
           * they are checked before the reading pause, not after it. Many stubs
           * carry no age until the listing is open: over ten days 1,671 listings
           * waited out a 5–8 s pause and a page check only to be dropped as too old.
           */
          const excluded = deterministicExclusion(job);
          if (excluded) {
            bump(excluded.startsWith('excluded company:') ? 'excluded company' : 'listing age');
            logOutcome({ status: 'skipped', jobId: job.id, reason: excluded, title: job.title, company: job.company });
            return;
          }

          /**
           * Reading pace, not network pace. At 1–3 s a hundred job ads went by in
           * fifteen minutes, and Cloudflare challenges are partly rate-based — the
           * one that blocked a run appeared on a plain search page.
           */
          if (!adapter.apiDiscovery) await jitter(5000, 8000);

          /**
           * The page verdict is for a listing whose description did not come
           * through: it tells a wall from a slow page from a job that has gone.
           * A listing that loaded needs no verdict. It was asked of every listing,
           * a reasoning-model call each, and over ten days it found six jobs
           * already applied for — which the application step detects on its own.
           */
          if (!job.description) {
            if (adapter.apiDiscovery) {
              bump('listing unavailable');
              logOutcome({ status: 'skipped', jobId: job.id, reason: 'The public job feed did not provide a description.', title: job.title, company: job.company, url: job.url });
              return;
            }
            const expected = `the ${adapter.label} job listing "${job.title}" at ${job.company}`;
            let verdict = await judgePage(reviewPage, expected);
            if (verdict.state === 'loading') {
              await jitter(3000, 5000);
              job = await measured('detail-retry', () => adapter.fetchJobDetail(reviewPage, stub), { jobId: stub.id });
              if (!job.description) verdict = await judgePage(reviewPage, expected);
            }

            if (!job.description) {
              if (WALL_STATES.has(verdict.state)) {
                const reason = `${verdict.state === 'captcha' ? 'CAPTCHA' : verdict.state === 'login' ? 'Login wall' : 'Verification gate'} before AI fit review — ${verdict.reason}`;
                console.log(`  ↷ ${adapter.label} unavailable before fit review — no AI review was sent`);
                bump(reason);
                reviewBlockedPlatforms.add(adapter.id);
                logOutcome({ status: 'skipped', jobId: job.id, reason, title: job.title, company: job.company });
                return;
              }
              console.log(`  ↷ ${job.title} @ ${job.company} — listing unavailable (${verdict.reason})`);
              bump('listing unavailable');
              logOutcome({ status: 'skipped', jobId: job.id, reason: `Listing unavailable: ${verdict.reason}`, title: job.title, company: job.company });
              return;
            }
          }

          // A loading retry can be the first read to reveal the board's applied marker.
          if (skipExistingApplication(job)) return;

          // Board application history must be checked before even the cheaper
          // instruction review, otherwise an old application rejected from its
          // search card would still consume an evaluation. Feed descriptions go
          // straight to their complete fit review as before.
          if (!stub.description && stub.source !== 'chosen' && applicationModelAvailable() && config.aiInstructions.trim()) {
            const cardRule = await ruleConflict(stub).catch(() => null);
            if (cardRule?.decision === 'skip' && cardRule.conflict) {
              const reason = `Your instructions rule this out ("${cardRule.conflict}"). ${cardRule.because}`;
              console.log(`  ✗ ${jobLabel(stub)} — ${reason} (from the search result)`);
              metric('fit-decision', 0, { jobId: stub.id, decision: 'skip', basis: 'search-result' });
              bump('fit mismatch');
              logOutcome({ status: 'skipped', jobId: stub.id, reason: `Fit check (skip): ${reason}`, title: stub.title, company: stub.company, url: stub.url,
                reviewCache: reviewCacheMetadata(stub, 'fit-mismatch', reviewContext, REVIEW_TTL.fit) });
              retained = true;
              return;
            }
          }

          // Both reviewers share the same model concurrency ceiling. Recheck after
          // every await before starting another call; page reading stays parallel.
          while (pendingFits.length >= config.limits.fitConcurrency) await flushFits();

          const heuristic = searchOnly ? scoreJob(job, profile) : null;
          const priority = reviewPriorities.get(reviewKey(job));
          const score = heuristic?.total ?? priority?.priority ?? 0;
          const scoreReasons = heuristic?.reasons ?? (priority?.reason ? [priority.reason] : []);
          /** The candidate's own call on a job the fit check skipped before; nothing to judge again. */
          const chosenFit: FitAssessment | null = stub.source === 'chosen'
            ? {
                decision: 'apply',
                shouldApply: true,
                matchScore: 100,
                reason: 'You chose to apply to this one after it was skipped.',
                evidence: ['Your call in the Skipped view'],
                injectionSuspected: false,
              }
            : null;
          const fitPromise = chosenFit
            ? Promise.resolve({ fit: chosenFit })
            : applicationModelAvailable()
            ? assessFit(job, profile).then(
                (fit) => ({ fit }),
                (error) => ({ error: (error as Error).message }),
              )
            : Promise.resolve({});
          const item = { job, score, scoreReasons, adapter, settled: false, fitPromise };
          void fitPromise.then(() => { item.settled = true; });
          pendingFits.push(item);
          retained = true;
          if (pendingFits.length >= config.limits.fitConcurrency) await flushFits();
        });
      } finally {
        if (!retained) restoreReviewSlot(stub, false);
      }
    };

    /** Moves review on by one step: answered fit checks first, then the next listing, then a check still out. */
    const advanceReview = async (reviewPage: Page = page, accept: (job: JobListing) => boolean = () => true, waitForOther = true): Promise<boolean> => {
      try {
        await settleAnswered();
        if (!reviewDone() && (hasUnreviewed(accept) || !hasUnreviewed())) {
          if (hasUnreviewed(accept)) await showLiveActivity({ phase: 'reviewing', detail: 'Checking job listings and matching your profile.' }, reviewPage);
          const review = reviewNext(reviewPage, accept);
          activeReviews.add(review);
          try { await review; } finally { activeReviews.delete(review); }
        } else if (pendingFits.length) {
          await showLiveActivity({ phase: 'waiting', detail: 'Waiting for profile match checks.' });
          await flushFits();
        }
        else if (activeReviews.size && waitForOther) {
          // The last slot may still be reading a page. Wait for its result or
          // restored capacity rather than spinning or declaring the run done.
          void showLiveActivity({ phase: 'waiting', detail: 'Waiting for reviews already in progress.' });
          await Promise.race([...activeReviews].map(review => review.catch(() => {})));
        } else if (!reviewDone() && workersRemaining > 1 && waitForOther) {
          // Only the other platform has queued listings. Its progress (or exit)
          // wakes us; never borrow its browser page or review the same board twice.
          void showLiveActivity({ phase: 'waiting', detail: 'No matching job ready on this platform.' });
          await new Promise<void>(resolve => workWaiters.add(resolve));
        } else return false;
        return true;
      } finally {
        workChanged();
        await showLiveActivity({ phase: 'waiting', detail: 'Looking for the next matching job.' });
      }
    };

    /**
     * Jobs the board hosts itself go first; the employer's own site is the
     * fallback for when those run out.
     *
     * Not a quality judgement — a hosted application is simply a far better
     * bet. It is one short known flow, it costs a fraction as much to complete,
     * and the resume and profile are already attached. External sites are every
     * vendor's form at once: longer, slower, and where every failed application
     * in this run came from. With a run cap in play, spending it on hosted
     * listings first means more applications actually land.
     */
    const hostedFirst = (job: JobListing): number => (job.applicationMode === 'external' ? 1 : 0);
    const preference = (a: (typeof candidates)[number], b: (typeof candidates)[number]) => {
      const hosted = hostedFirst(a.job) - hostedFirst(b.job);
      if (hosted) return hosted;
      const sourcePriority = Number(b.job.source === 'recommended') - Number(a.job.source === 'recommended');
      return sourcePriority || b.score - a.score;
    };
    /**
     * The best qualified job still to try. An employer-site one waits until
     * review can find no hosted one, but only while hosted applications are
     * in this run's scope: in an employer-sites-only run every candidate is
     * an employer site, and waiting had the run review every listing it could
     * find (up to the evaluation cap, half an hour) before its first application.
     */
    const bestCandidate = (accept: (job: JobListing) => boolean = () => true) => {
      const best = candidates.filter((c) => accept(c.job) && !stoppedPlatform(c.job.platform ?? 'seek')).sort(preference)[0];
      if (!best) return undefined;
      if (hostedFirst(best.job) === 1 && active.some(adapter => !adapter.apiDiscovery) && !outsideScope('hosted') && !reviewExhausted()) return undefined;
      return best;
    };
    const takeCandidate = (accept: (job: JobListing) => boolean) => {
      const best = bestCandidate(accept);
      if (best) candidates.splice(candidates.indexOf(best), 1);
      return best;
    };

    const printSummary = () => {
      if (skips.size) {
        console.log('\nFiltered out:');
        for (const [reason, n] of [...skips].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${String(n).padStart(3)} × ${reason}`);
        }
      }
      console.log(`\n${qualified} qualifying jobs.\n`);
      // A review cut short by the run cap is not a sparse search: the dashboard only renews search terms after a complete one.
      saveRunSummary(qualified, reviewExhausted() && !reviewStopped);
    };

    if (searchOnly) {
      while (!reviewExhausted()) await advanceReview();
      printSummary();
      console.table(
        [...candidates].sort(preference).map((c) => ({
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
    /**
     * A pause spent reviewing. A listing takes about ten seconds (the page and
     * its reading pause), so a new one is only started while at least that
     * much of the pause is left; whatever remains is then waited out.
     */
    const REVIEW_STEP_MS = 10_000;
    const pauseWhileReviewing = async (minMs: number, maxMs: number, reviewPage: Page, accept: (job: JobListing) => boolean) => {
      const until = Date.now() + Math.floor(minMs + Math.random() * (maxMs - minMs));
      while (Date.now() < until - REVIEW_STEP_MS && !reviewExhausted()) {
        if (!await advanceReview(reviewPage, accept, false)) break;
      }
      const left = until - Date.now();
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    };
    /**
     * The pause before the next application. A cooldown only protects the
     * next interaction, so a run with nothing left to do does not wait it out.
     */
    const cooldown = async (full: boolean, reviewPage: Page, accept: (job: JobListing) => boolean) => {
      if (reviewExhausted() && !bestCandidate(accept)) return;
      await pauseWhileReviewing(
        full ? config.limits.minDelayMs : config.limits.minNonSubmitDelayMs,
        full ? config.limits.maxDelayMs : config.limits.maxNonSubmitDelayMs,
        reviewPage,
        accept,
      );
    };
    // ---- apply -----------------------------------------------------------
    let applied = 0;
    let rehearsed = 0;

    /** Employer-site applications actually SUBMITTED today, across runs. Failures cost model calls but not allowance. */
    let externalSubmitted = config.limits.externalAttemptsToday;
    const slots = new ApplicationSlots({ run: config.limits.maxApplicationsPerRun,
      day: config.limits.maxApplicationsPerDay, external: config.limits.maxExternalPerDay,
      appliedToday: () => index.appliedToday(),
      externalToday: config.limits.externalAttemptsToday });
    const parallel = process.env.APPLICATION_WORKERS === '2' && active.some(adapter => adapter.id === 'seek')
      && active.some(adapter => adapter.id === 'indeed');
    const contexts: BrowserContext[] = [];
    // A missing context feature falls back before any application has started.
    if (parallel) {
      try { contexts.push(...await applicationWorkerContexts(ctx, 2)); }
      catch (error) { console.warn(`Parallel sessions unavailable; using one worker: ${(error as Error).message}`); }
    }
    const runWorker = async (applicationPage: Page, accept: (job: JobListing) => boolean) => {
      for (;;) {
        if (applied + (config.dryRun && process.env.REHEARSE === 'true' ? rehearsed : 0) >= config.limits.maxApplicationsPerRun) break;
        // An application deadline retires its outstanding browser work. Start
        // the next review/attempt in this same isolated worker session.
        {
          const previousPage = applicationPage;
          applicationPage = await applicationWorkerPage(previousPage);
          // Single-worker fallback discovery shares this page. Keep that
          // reference current as well; parallel discovery has its own page.
          if (page === previousPage) page = applicationPage;
        }
        await showLiveActivity({ phase: 'waiting', detail: 'Looking for the next matching job.' });
        // Each worker reads and applies on its own isolated page. Only fallback
        // discovery uses the persistent page; queue claims and budgets are shared.
        let next = takeCandidate(accept);
        while (!next && !reviewExhausted()) {
          if (!await advanceReview(applicationPage, accept)) break;
          next = takeCandidate(accept);
        }
        if (!next) {
          // Another application may restore a review slot or produce new
          // candidates during its cooldown. Stay available until all are idle.
          if (busyWorkers) {
            // Do not yield between checking busyWorkers and registering the
            // wakeup: an observation update must not lose the last work signal.
            void showLiveActivity({ phase: 'waiting', detail: 'No matching job ready. Waiting for the other worker to finish or new jobs to become available.' });
            await new Promise<void>(resolve => workWaiters.add(resolve)); continue;
          }
          break;
        }
        busyWorkers++;

        try {
          const { job, score, reasons } = next;
          const platformId = job.platform ?? 'seek';
          const adapter = ADAPTERS.get(platformId);
          if (!adapter) continue;

          // A listing whose kind is already known and outside this run's scope is not attempted; an unknown one is left to the board's own panel to decide.
          if (job.applicationMode && job.applicationMode !== 'unknown' && outsideScope(job.applicationMode)) {
            logOutcome({ status: 'skipped', jobId: job.id, reason: scopeSkipReason(), title: job.title, company: job.company });
            continue;
          }

          // Check this exact listing/form again: another attempt may have finished since discovery.
          if (skipExistingApplication(job)) {
            restoreReviewSlot(job, true);
            continue;
          }

          if (job.applicationMode === 'external') {
            if (externalSubmitted >= config.limits.maxExternalPerDay) {
              console.log(`  – skipped (daily limit of ${config.limits.maxExternalPerDay} employer-site applications reached): ${job.title} @ ${job.company}`);
              logOutcome({ status: 'skipped', jobId: job.id, reason: `daily limit of ${config.limits.maxExternalPerDay} employer-site applications reached`, title: job.title, company: job.company });
              continue;
            }
          }

          if (abortedPlatforms.has(platformId)) {
            console.log(`  – skipped (${adapter.label} stopped earlier this run after repeated friction): ${job.title} @ ${job.company}`);
            continue;
          }
          if (blockedPlatforms.has(platformId)) {
            console.log(`  – skipped (${adapter.label} hit a security check earlier this run): ${job.title} @ ${job.company}`);
            continue;
          }

          // A rehearsal's cap counts every application that reached its end, so one that somehow went out still stops it.
          const completed = config.dryRun && process.env.REHEARSE === 'true' ? rehearsed + applied : applied;
          if (completed >= config.limits.maxApplicationsPerRun) {
            console.log(`\nRun cap of ${config.limits.maxApplicationsPerRun} reached.`);
            break;
          }
          if (index.appliedToday() >= config.limits.maxApplicationsPerDay) {
            console.log(`\nDaily cap of ${config.limits.maxApplicationsPerDay} reached.`);
            break;
          }

          await showLiveActivity({ phase: 'waiting', detail: 'Waiting for an application slot.' });
          const slot = await slots.acquire(job.applicationMode === 'external');
          if (!slot) {
            console.log('Shared application allowance is reached; this worker is finished.');
            break;
          }

          let finalOutcome: ApplyOutcome | undefined;
          let finalized = false;
          const finalize = () => {
            if (finalized) return;
            finalized = true;
            slot.finish(finalOutcome?.status === 'applied');
          };
          try {
            console.log(`\n→ Applying: ${job.title} @ ${job.company}`);

            /**
             * A dead browser must not take the whole run's reporting with it. It is
             * unrecoverable (every later job would fail the same way), but the run
             * still has to say what it completed rather than dying with a stack
             * trace — and has to be explicit that this job was NOT submitted.
             */
            let outcome: ApplyOutcome;
            // Applying opens the board's listing again: a search just made there still has its gap to run out.
            await showLiveActivity({ phase: 'waiting', detail: 'Pausing before opening this application.' });
            await sitePacer.ready(platformId);
            await showLiveActivity({ phase: 'applying', detail: `${job.title} at ${job.company}` }, applicationPage);
            try {
              const apply = () => measured('application', () => adapter.apply(applicationPage, job, profile, {
                onFriction: () => {},
              }), { jobId: job.id, platform: platformId });
              outcome = await withApplicationAllowance(slot.beforeSubmit, apply);
            } catch (err) {
              const msg = (err as Error).message;
              const submitPressed = applicationFailureContext(err)?.submitPressed === true;
              finalOutcome = { status: 'error', jobId: job.id, error: msg, submitPressed };

              if (/Target page, context or browser has been closed|browser has disconnected|Target closed/i.test(msg)) {
                console.log(
                  `\n🛑 The browser closed mid-run — "${job.title} @ ${job.company}" submission was not confirmed.\n` +
                    `   Usual causes: the Chrome window was closed, another process killed it,\n` +
                    `   or a page became unavailable. The original error and browser state were captured before cleanup.`,
                );
                logOutcome({
                  status: 'error',
                  jobId: job.id,
                  error: 'The application browser became unavailable before submission was confirmed.',
                  submitPressed,
                  title: job.title,
                  company: job.company,
                });
                break;
              }
              console.log(`  ✗ unexpected error: ${msg}`);
              logOutcome({ status: 'error', jobId: job.id, error: msg, submitPressed, title: job.title, company: job.company });
              // It may have failed halfway through the board's form, so the next request still keeps its distance.
              await cooldown(false, applicationPage, accept);
              continue;
            }
            finalOutcome = outcome;
            logOutcome({ ...outcome, title: job.title, company: job.company });
            // Accounts, sign-ins and documents added are the candidate's business whatever the outcome.
            for (const action of outcome.actions ?? []) console.log(`  ℹ ${action.detail}`);
            if (['applied', 'needs-human', 'skipped', 'error'].includes(outcome.status)) countHealth('attempted');
            if (outcome.status === 'applied') countHealth('applied');
            if (outcome.status === 'needs-human') countHealth('needsHuman');

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
                  ...(outcome.resume ? { resume: outcome.resume } : {}),
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
                console.log(`  🧪 rehearsed — form completed, submit withheld (DRY_RUN)${outcome.resume ? ` · resume "${outcome.resume}"` : ''}`);
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
                restoreReviewSlot(job, true);
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

            finalize();

            const completedAfter = config.dryRun && process.env.REHEARSE === 'true' ? rehearsed : applied;
            if (completedAfter >= config.limits.maxApplicationsPerRun) {
              console.log(`\nRun cap of ${config.limits.maxApplicationsPerRun} reached.`);
              break;
            }
            /**
             * Full pacing after anything that may have reached the employer: a
             * confirmed submission, a verification wall, or a submit that was pressed
             * but never confirmed — that one may well have been sent, and used to get
             * only the short gap meant for attempts that transmitted nothing.
             */
            await showLiveActivity({ phase: 'cooldown', detail: outcome.status === 'applied'
              ? 'Application submitted. Pausing before the next job.' : 'Pausing before the next job.' });
            await cooldown(outcome.status === 'applied' || Boolean(outcome.submitPressed), applicationPage, accept);
          } finally {
            finalize();
          }
        } finally {
          busyWorkers--;
          workChanged();
        }
      }
    };
    try {
      let workerPages: Page[] = [];
      if (contexts.length === 2) {
        try {
          workerPages = await Promise.all(contexts.map(context => context.newPage()));
          const sessions = await Promise.allSettled([ensureSignedIn(workerPages[0]), ensureIndeedSignedIn(workerPages[1])]);
          const failed = sessions.find(result => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        } catch (error) {
          await Promise.allSettled(contexts.map(context => context.close()));
          contexts.length = 0;
          workerPages = [];
          console.warn(`Parallel session validation failed; using the original single-worker session: ${(error as Error).message}`);
        }
      }
      console.log(`Application workers: ${contexts.length === 2 ? '2 (SEEK and Indeed/feeds, isolated sessions)' : '1'}`);
      if (contexts.length === 2) {
        workersRemaining = 2;
        configureLiveWorkers(config.dataDir, ['seek', 'indeed']);
        const runVisibleWorker = (id: 'seek' | 'indeed', workerPage: Page, accept: (job: JobListing) => boolean) =>
          withApplicationWorker(id, async () => {
            try {
              await showLiveActivity({ phase: 'starting', detail: 'Getting this worker ready.' });
              await runWorker(workerPage, accept);
            } finally {
              workersRemaining--;
              workChanged();
              await showLiveActivity({ phase: 'finished', detail: 'This worker has finished its work for this run.' });
            }
          });
        const results = await Promise.allSettled([
          runVisibleWorker('seek', workerPages[0], job => (job.platform ?? 'seek') === 'seek'),
          runVisibleWorker('indeed', workerPages[1], job => (job.platform ?? 'seek') !== 'seek'),
        ]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } else await runWorker(page, () => true);
    } finally {
      await Promise.allSettled(contexts.map(context => context.close()));
    }

    printSummary();

    console.log(`\n=== Run complete: ${applied} new application(s) ===`);
    console.log(`Log: data/run-log.jsonl · Store: data/applied.json`);
  } finally {
    metric('run-total', performance.now() - startedAt);
    await closeBrowser(ctx);
    // Reviews of failed attempts still running finish before the process ends, so their lessons are kept.
    await settleReviews();
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
