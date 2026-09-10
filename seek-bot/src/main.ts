import { measured, metric } from './pipeline.js';
import { pickResumeForJob } from './resume.js';
import { coverLetterForJob } from './llm.js';
import { config, loadProfile } from './config.js';
import {
  launchBrowser,
  closeBrowser,
  getPage,
  assertSignedIn,
  assertIndeedSignedIn,
  jitter,
} from './browser.js';
import { judgePage, WALL_STATES } from './blocker.js';
import { recommended, search, fetchJobDetail } from './discovery.js';
import {
  recommended as recommendedIndeed,
  search as searchIndeed,
  fetchJobDetail as fetchJobDetailIndeed,
} from './discovery-indeed.js';
import { scoreJob, hardExclusions, detectInjection, looksTemplated } from './scoring.js';
import { assessFit } from './llm.js';
import { applyToIndeedJob } from './apply-indeed.js';
import { applyToJobWithAgent, type ApplyDeps } from './agent/apply-agent.js';
import { AppliedIndex, logOutcome, syncFromSeek } from './store.js';
import { assertHumanizerHealthy } from './humanizer.js';
import { enabledPlatforms, type PlatformId } from './platforms.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';
import type { Page } from 'patchright';

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
      assertSignedIn,
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
      assertSignedIn: assertIndeedSignedIn,
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
  if (!config.keywords.length && !config.targetRole) throw new Error('Set your job search terms or target role before running.');
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
      `Browser agent: Celeris ` +
        `(max ${config.celeris.maxSteps} steps, $${config.celeris.budgetUsdPerApplication.toFixed(3)}/application)`,
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
  const already = index.appliedToday();
  console.log(`Known applications: ${index.all.length} (${already} today)`);

  if (already >= config.limits.maxApplicationsPerDay) {
    console.log(`Daily cap of ${config.limits.maxApplicationsPerDay} already reached. Stopping.`);
    return;
  }

  const platforms = enabledPlatforms(config.platforms.join(','));
  console.log(`Platforms this run: ${platforms.map((p) => p.label).join(', ')}`);

  const ctx = await launchBrowser();
  const page = await getPage(ctx);

  try {
    // ---- per-platform sign-in + discovery ---------------------------------
    // A sign-in failure or a stale session on one platform must not take the
    // other down with it — seek.md requires exactly this isolation.
    const seen = new Map<string, JobListing>();
    const active: PlatformAdapter[] = [];

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

      const recommendations = await adapter.recommended(page).catch((error) => {
        console.warn(`  ${adapter.label} Recommended could not be loaded: ${(error as Error).message}`);
        return [] as JobListing[];
      });
      for (const job of recommendations) seen.set(`${adapter.id}:${job.id}`, job);
      console.log(`  ${adapter.label} Recommended -> ${recommendations.length} personalised jobs (priority)`);

      for (const kw of config.keywords.length ? config.keywords : [config.targetRole]) {
        let kwTotal = 0;
        for (let p = 1; p <= config.limits.pagesPerKeyword; p++) {
          const results = await measured('discovery', () => adapter.search(page, kw, p), { platform: adapter.id });
          // An empty or short page means we have reached the end of the results.
          if (!results.length) break;
          kwTotal += results.length;
          for (const j of results) {
            const key = `${adapter.id}:${j.id}`;
            if (!seen.has(key)) seen.set(key, j);
          }
          await jitter(config.limits.searchDelayMs, config.limits.searchDelayMs * 1.8);
          if (results.length < adapter.pageSize) break;
        }
        console.log(
          `  [${adapter.label}] "${kw}" → ${kwTotal} results` +
            (config.limits.pagesPerKeyword > 1 ? ` (${config.limits.pagesPerKeyword} pages)` : ''),
        );
      }
    }

    console.log(`\n${seen.size} unique listings discovered across ${active.length} platform(s).`);

    if (!active.length) {
      console.log('No enabled platform has a working session this run. Nothing to do — sign in and try again.');
      return;
    }

    // ---- cheap filtering before we spend page loads or model calls --------
    const shortlist: JobListing[] = [];
    for (const job of seen.values()) {
      if (index.has(job.id, job.company, job.title, job.location)) continue;
      if (job.ageDays !== undefined && job.ageDays > config.rules.maxAgeDays) continue;
      shortlist.push(job);
    }
    /**
     * Pre-rank on the cheap stub data (title + teaser + recency) before
     * spending a detail fetch on anything. Without this the evaluation cap is
     * consumed in keyword/platform order, so whichever ran first monopolises
     * the budget regardless of quality — which gets worse the more keywords
     * (or platforms) exist. Cross-platform on purpose: seek.md treats every
     * enabled board as one combined, deduplicated pipeline, not separate runs.
     */
    shortlist.sort((a, b) => {
      const sourcePriority = Number(b.source === 'recommended') - Number(a.source === 'recommended');
      return sourcePriority || scoreJob(b, profile).total - scoreJob(a, profile).total;
    });
    console.log(`${shortlist.length} after dedupe + age filter (pre-ranked).\n`);

    const candidates: Array<{ job: JobListing; score: number; why: string; reasons: string[] }> = [];
    const skips = new Map<string, number>();
    const bump = (reason: string) => skips.set(reason, (skips.get(reason) ?? 0) + 1);
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
     * Collect a buffer of candidates beyond what we can apply to, since some
     * will turn out to be off-platform or already applied. The floor matters:
     * a run capped at 1 application would otherwise stop scoring after 3
     * candidates and waste the whole evaluation budget.
     */
    const candidateCap = Math.max(12, config.limits.maxApplicationsPerRun * 3);

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
            });
            continue;
          }
          why = fit.reason;
        }

        candidates.push({
          job,
          score,
          why,
          reasons: job.strongApplicant
            ? [`SEEK: ${job.strongApplicantNote ?? 'strong applicant'}`, ...scoreReasons]
            : scoreReasons,
        });
        console.log(
          `  ✓ ${score} · ${job.title} @ ${job.company} (${job.location}) [${adapter.label}]` +
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
      if (evaluated >= config.limits.maxEvaluations) {
        console.log(`  … evaluation cap (${config.limits.maxEvaluations}) reached`);
        break;
      }
      evaluated++;

      let job = await measured('detail', () => adapter.fetchJobDetail(page, stub), { jobId: stub.id });
      /**
       * Reading pace, not network pace. At 1–3 s a hundred job ads went by in
       * fifteen minutes, and Cloudflare challenges are partly rate-based — the
       * one that blocked a run appeared on a plain search page.
       */
      await jitter(5000, 8000);

      /**
       * A listing with no description is the only signal that something is
       * wrong at this stage, and the model is asked why only then: a wall
       * hands the platform to a person, a slow page gets one retry, and a
       * removed listing is skipped instead of being sent to the fit review
       * with a blank description.
       */
      if (!job.description) {
        const expected = `the ${adapter.label} job listing "${job.title}" at ${job.company}`;
        let verdict = await judgePage(page, expected);
        if (verdict.state === 'loading') {
          await jitter(3000, 5000);
          job = await measured('detail-retry', () => adapter.fetchJobDetail(page, stub), { jobId: stub.id });
          if (!job.description) verdict = await judgePage(page, expected);
        }
        if (!job.description) {
          if (WALL_STATES.has(verdict.state)) {
            const reason = `${verdict.state === 'captcha' ? 'CAPTCHA' : verdict.state === 'login' ? 'Login wall' : 'Verification gate'} before AI fit review — ${verdict.reason}`;
            console.log(`  ⏸ ${adapter.label} needs manual verification — no AI review was sent`);
            bump(reason);
            reviewBlockedPlatforms.add(adapter.id);
            logOutcome({ status: 'needs-human', jobId: job.id, reason, url: page.url(), title: job.title, company: job.company });
            continue;
          }
          console.log(`  ↷ ${job.title} @ ${job.company} — listing unavailable (${verdict.reason})`);
          bump('listing unavailable');
          logOutcome({ status: 'skipped', jobId: job.id, reason: `Listing unavailable: ${verdict.reason}`, title: job.title, company: job.company });
          continue;
        }
      }

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
        });
        continue;
      }

      const injection = detectInjection(job);
      if (injection) {
        console.log(`  ⚠ ${job.company} — ${injection} (treated as data, listing skipped)`);
        logOutcome({ status: 'skipped', jobId: job.id, reason: injection, title: job.title, company: job.company });
        continue;
      }

      const templated = looksTemplated(job);
      if (templated) {
        console.log(`  ⚠ ${job.company} — flagged templated/spam: ${templated}`);
        logOutcome({
          status: 'skipped',
          jobId: job.id,
          reason: `templated: ${templated}`,
          title: job.title,
          company: job.company,
        });
        continue;
      }

      const excluded = hardExclusions(job, profile);
      if (excluded) {
        bump(excluded.replace(/:.*/, '').trim());
        logOutcome({ status: 'skipped', jobId: job.id, reason: excluded, title: job.title, company: job.company });
        continue;
      }

      const s = scoreJob(job, profile);
      // Keyword scores order the review queue; only the role-neutral model decides fit.
      const fitPromise = config.celeris.apiKey
        ? assessFit(job, profile).then(
            (fit) => ({ fit }),
            (error) => ({ error: (error as Error).message }),
          )
        : Promise.resolve({});
      pendingFits.push({ job, score: s.total, scoreReasons: s.reasons, adapter, fitPromise });
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

      // Diagnostic: APPLY_ONLY=external|hosted restricts a run to one kind of application, for testing a flow in isolation.
      const only = process.env.APPLY_ONLY;
      if (only === 'external' && job.applicationMode !== 'external') continue;
      if (only === 'hosted' && job.applicationMode === 'external') continue;

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
        console.log('\nDaily cap reached.');
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
          });
          console.log(`  ✅ submitted (${applied}/${config.limits.maxApplicationsPerRun})`);
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
