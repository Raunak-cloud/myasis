import { EMPLOYER_SOURCES, isEmployerSource } from '../../seek-bot/src/employer-source-config.js';
import { readEnv, runner, type RunMode } from './runner.js';
import { brightDataBrowserEndpoint, employerBrowserProvider } from '../../seek-bot/src/employer-browser-config.js';
import { runSettingsSnapshotForUser, USER_SETTABLE_SETTINGS_KEYS, DAILY_APPLICATION_CAP_CHOSEN } from './settings.js';
import {
  billingStatus,
  consumeSuccessfulApplication,
  isAdmin,
  type BillingStatus,
} from './billing.js';
import {
  applyRunPolicy,
  PLATFORMS_CHOSEN_KEY,
  discardRunStart,
  entitlementsFor,
  recordRunStart,
  mayEditRunSetting,
  INTENSIVE_EMPLOYER_SITES_PER_DAY,
  type Entitlements,
} from './entitlements.js';
import { listResumes } from './files.js';
import { checkSignin, waitForSigninChecks } from './seek-check.js';
import { sessionFor, stopSignin } from './signin.js';
import { externalSubmittedToday, submittedToday } from './today.js';
import { readSiteState } from './seek-state.js';
import { browserRoute, describeRoute } from './route.js';
import { releaseFreeProxy } from './proxy-pool.js';
import { query } from './db/index.js';
import { validateExternalJobUrl } from './external-job-url.js';
import { mayRunEmployerSiteApplications } from './employer-site-access.js';
import { applyJobSourceAccess, availableJobSources, jobSourceSettingsError } from './job-sources.js';
import { loadProfile } from './profile.js';
import { annualSalaryAmount, EXPECTED_SALARY_REQUIRED } from '../src/salary.js';
import type { RunDevice } from '../src/run-device.js';
import { applicationsForConfirmation, claimApplicationReviews, pendingReviewKeys, releaseApplicationReviews, reviewSelection, ApplicationReviewError } from './application-reviews.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';
import { isExternalApplicationUrl } from '../../seek-bot/src/job-board-url.js';
import { validateCoverLetterInstructions } from '../../seek-bot/src/cover-letter-policy.js';
import { gmailAccess } from './gmail-access.js';
import { scheduledStart } from './run-schedule.js';
import { dailyApplicationLimit, USER_RUN_LIMITS } from '../../seek-bot/src/run-limits.js';

const BOARD_NAMES: Record<string, string> = { seek: 'SEEK', indeed: 'Indeed' };
const listNames = (boards: string[]) => boards.map((board) => BOARD_NAMES[board] ?? board).join(' and ');

/**
 * The one way a run starts.
 *
 * A run can begin two ways — a person presses start, or the scheduler fires —
 * and both have to apply the same rules: the account's own saved settings,
 * its entitlement to employer-site applications, its allowance, and the
 * deduction when an application actually lands. Those rules used to live
 * inside the HTTP handler, which meant the scheduler either duplicated them
 * or quietly skipped them. Neither is acceptable for something that submits
 * real applications under a candidate's name, so both callers come here.
 */

type StartRunOutcome =
  | { ok: true; mode: RunMode }
  | { ok: false; status: number; error: string };

interface StartRunRequest {
  userId: string;
  email?: string | null;
  mode: RunMode;
  applicationMode?: 'auto' | 'semi-auto';
  scheduleGeneration?: number;
  approvals?: unknown;
  /**
   * Who asked: the account holder, the scheduler, or an admin acting for the
   * account. An admin's run follows the account's plan exactly as a scheduled
   * run does, and does not use up one of the account's scheduled runs.
   */
  trigger: 'manual' | 'auto' | 'admin' | 'onboarding';
  /** The admin who started it, for the record. */
  startedBy?: string | null;
  /** Browser device that initiated the request; absent for scheduler/CLI starts. */
  initiatorDevice?: RunDevice | null;
  /**
   * Settings posted with the request: by the account holder, or by an admin
   * narrowing a run for the account (run-account.mjs). Ignored for scheduled runs.
   */
  clientOverrides?: Record<string, unknown>;
  /** Limit the run to one kind of application. Honoured only for accounts entitled to it. */
  scope?: unknown;
  /** Admin diagnostic retries, still subject to normal eligibility and limits. */
  jobIds?: unknown;
  /** One exact employer job page supplied by an administrator. */
  externalUrl?: unknown;
  /** Explicit operator exception, resolved for this run only; never saved as account settings. */
  oneTime?: { allowMissingSalary?: boolean; maxApplications?: number; maxEvaluations?: number };
}

type Refusal = Extract<StartRunOutcome, { ok: false }>;

export function expectedSalaryRefusal(profile: { expectedSalary: string }): Refusal | null {
  return annualSalaryAmount(profile.expectedSalary) === null
    ? { ok: false, status: 400, error: EXPECTED_SALARY_REQUIRED }
    : null;
}

/** Every plan can expose Start; the separate daily quota still applies. */
export function manualRunRefusal(entitlements: Pick<Entitlements, 'manualRuns' | 'firstRunRequired'>): Refusal | null {
  if (!entitlements.manualRuns && !entitlements.firstRunRequired) {
    return { ok: false, status: 403, error: 'This account cannot start an application run.' };
  }
  return null;
}

export function runControlRefusal(trigger: StartRunRequest['trigger'], entitlements: Pick<Entitlements, 'tier' | 'autoRunsUsedToday' | 'autoRunsPerDay'>, approvalOnly = false): Refusal | null {
  if (trigger === 'manual' && entitlements.tier !== 'admin' && !approvalOnly) return { ok: false, status: 403, error: 'Press Start to enable your scheduled Auto apply or Semi auto runs.' };
  return null;
}

/** A live run needs at least one application left to spend. The free allowance is given once, so there is nothing to wait for. */
export function allowanceRefusal(allowance: Pick<BillingStatus, 'totalRemaining'>): Refusal | null {
  return allowance.totalRemaining < 1
    ? { ok: false, status: 402, error: 'No application credits remain. Choose a pass to keep applying.' }
    : null;
}

/**
 * One start per account at a time.
 *
 * Preparing a run closes any browser left on the account's profile. Before
 * this claim, a second Start (a double click, or the scheduler and a person
 * together) reached that clean-up while the first run's browser was open,
 * closed it, and was then refused as "already in progress".
 */
export async function startRun(request: StartRunRequest): Promise<StartRunOutcome> {
  if (request.trigger === 'auto' && (!Number.isInteger(request.scheduleGeneration) || !request.applicationMode)) {
    return { ok: false, status: 403, error: 'An active user-enabled schedule is required.' };
  }
  if (!runner.claimStart(request.userId)) {
    return { ok: false, status: 409, error: runner.inUse(request.userId)
      ? 'A run is already starting or in progress for this account.'
      : 'The server is busy with other runs. Scheduled runs stay queued until a slot is available.' };
  }
  try {
    return await prepareAndStart(request);
  } finally {
    runner.releaseStart(request.userId);
  }
}

async function prepareAndStart(request: StartRunRequest): Promise<StartRunOutcome> {
  const { userId, email, mode, trigger } = request;
  const admin = isAdmin(email);
  const sourceError = jobSourceSettingsError(request.clientOverrides ?? {}, admin);
  if (sourceError) return { ok: false, ...sourceError };
  let borrowFreeProxy = false;
  const entitlements = await entitlementsFor(userId, email);
  const controlRefused = runControlRefusal(trigger, entitlements, request.approvals !== undefined);
  if (controlRefused) return controlRefused;
  if (request.applicationMode !== undefined && !['auto', 'semi-auto'].includes(request.applicationMode)) return { ok: false, status: 400, error: 'Choose Auto apply or Semi auto.' };
  try {
    if (request.clientOverrides?.COVER_LETTER_INSTRUCTIONS !== undefined) validateCoverLetterInstructions(request.clientOverrides.COVER_LETTER_INSTRUCTIONS);
  } catch (error) { return { ok: false, status: 400, error: (error as Error).message }; }
  if (request.approvals !== undefined && (trigger !== 'manual' || mode !== 'live' || request.applicationMode === 'semi-auto')) return { ok: false, status: 400, error: 'Confirmed applications must be submitted from the review list.' };
  const onboarding = trigger === 'manual' && !admin && entitlements.firstRunRequired;
  const effectiveTrigger = onboarding ? 'onboarding' : trigger;
  /** A search-only run never reaches an employer; a live run submits applications. */
  const consumes = mode === 'live';

  if (request.oneTime !== undefined) {
    if (trigger !== 'admin' || !consumes || !request.startedBy) {
      return { ok: false, status: 403, error: 'One-time run exceptions require an administrator starting a live run.' };
    }
    const actor = await query<{ email: string }>('SELECT email FROM users WHERE id = $1 AND blocked_at IS NULL', [request.startedBy]);
    if (!isAdmin(actor[0]?.email)) return { ok: false, status: 403, error: 'One-time run exceptions require an administrator.' };
    const oneTime = request.oneTime;
    if (!oneTime || typeof oneTime !== 'object' || Array.isArray(oneTime)
      || (oneTime.allowMissingSalary !== undefined && typeof oneTime.allowMissingSalary !== 'boolean')
      || (oneTime.maxApplications !== undefined && (!Number.isInteger(oneTime.maxApplications) || oneTime.maxApplications < 1 || oneTime.maxApplications > USER_RUN_LIMITS.MAX_APPS_PER_DAY))
      || (oneTime.maxEvaluations !== undefined && (!Number.isInteger(oneTime.maxEvaluations) || oneTime.maxEvaluations < 1 || oneTime.maxEvaluations > 150))) {
      return { ok: false, status: 400, error: `Use 1–${USER_RUN_LIMITS.MAX_APPS_PER_DAY} applications and 1–150 job reviews for a one-time run.` };
    }
  }

  /**
   * Whether this account drives runs at all, checked before anything else.
   *
   * The UI hides these controls for a standard account, but hiding a button
   * is not a rule — this is. It covers every mode: a search-only run spends
   * the same fit checks as a live one, and left outside this check any
   * account could start as many as it liked.
   */
  if (trigger === 'manual') {
    const refused = manualRunRefusal(entitlements);
    if (refused) return refused;
  }
  if (onboarding && mode !== 'live') {
    return { ok: false, status: 403, error: 'Your first run must be a live run started from the Apply page.' };
  }

  const salaryRefused = expectedSalaryRefusal(await loadProfile(userId));
  if (salaryRefused && request.oneTime?.allowMissingSalary !== true) return salaryRefused;

  /**
   * Nothing works without one. The agent attaches a resume on nearly every
   * form, the fit check reads it, and the cover letter is written from it —
   * so a run without one wastes an employer's time and the candidate's
   * allowance before failing on the document step.
   */
  if (consumes && !(await listResumes(userId)).length) {
    return {
      ok: false,
      status: 400,
      error: 'Upload your resume first. Applications are built from it.',
    };
  }

  const settingsSnapshot = await runSettingsSnapshotForUser(userId, { unlimited: admin });
  const settings = settingsSnapshot.settings;

  /**
   * Only known per-account settings are accepted from a browser: without this
   * filter a request could set PROFILE_PATH or DATA_DIR and point its own run
   * at another account's files. An account that may not fine-tune cannot post
   * the behaviour settings either, whatever its UI is showing.
   */
  for (const [key, value] of Object.entries(request.clientOverrides ?? {})) {
    if (trigger !== 'manual' && trigger !== 'admin') break;
    if (!USER_SETTABLE_SETTINGS_KEYS.includes(key as (typeof USER_SETTABLE_SETTINGS_KEYS)[number])) continue;
    if (!mayEditRunSetting(key, entitlements)) continue;
    if (value !== undefined && value !== null && String(value).length) settings[key] = String(value);
  }

  /**
   * The plan decides last.
   *
   * Posted settings used to be merged after the plan was applied, and the
   * review screen posts every saved run setting — including the default of 40
   * jobs to evaluate — so Get Owtomated sold as 80 jobs a run reviewed 40,
   * and the Indeed board its pass includes was dropped whenever the account
   * had not picked boards itself.
   */
  const overrides = applyRunPolicy(settings, entitlements, admin && effectiveTrigger === 'manual' ? 'manual' : 'auto', settingsSnapshot.saved[PLATFORMS_CHOSEN_KEY] === '1');
  overrides.APPLICATION_REVIEW_MODE = request.applicationMode === 'semi-auto' ? 'prepare' : '';
  overrides.PENDING_APPLICATION_KEYS_JSON = JSON.stringify(await pendingReviewKeys(userId));
  let selections;
  try { selections = request.approvals === undefined ? null : reviewSelection(request.approvals); }
  catch (error) { return { ok: false, status: 400, error: (error as Error).message }; }
  let prepaid: PreparedApplication[] = [];
  try {
    if (selections) prepaid = await applicationsForConfirmation(userId, selections);
  } catch (error) { return { ok: false, status: 409, error: (error as Error).message }; }
  const prepaidExternal = prepaid.filter(item => item.job.applicationMode === 'external' || isExternalApplicationUrl(item.formUrl)).length;
  const emailOnly = prepaid.length > 0 && prepaid.every(item => item.email);
  const gmail = await gmailAccess(userId);
  const needsBrowser = !emailOnly || gmail.provider === 'browser';
  if (prepaid.some(item => item.email) && !gmail.connected) return { ok: false, status: 409, error: 'Connect Gmail in Settings before confirming email applications.' };
  if (request.oneTime?.maxApplications !== undefined) overrides.MAX_APPS_PER_RUN = String(request.oneTime.maxApplications);
  if (request.oneTime?.maxEvaluations !== undefined) overrides.MAX_EVALUATIONS = String(request.oneTime.maxEvaluations);
  /**
   * An admin narrowing a run to boards is a decision, even when it reads like
   * the default: the policy turns a plain "seek" into "seek,indeed" for a pass
   * that includes Indeed, so "SEEK only" searched and applied on Indeed too.
   */
  const narrowedBoards = trigger === 'admin' ? String(request.clientOverrides?.PLATFORMS ?? '').trim() : '';
  if (narrowedBoards && narrowedBoards.split(',').every((board) => ['seek', 'indeed', ...(admin ? EMPLOYER_SOURCES.map(source => source.id) : [])].includes(board.trim()))) {
    overrides.PLATFORMS = narrowedBoards;
  }
  try {
    applyJobSourceAccess(overrides, admin);
    if (mode === 'live' && !emailOnly) {
      const browserEnv = { ...readEnv(), ...process.env, ...overrides };
      if (employerBrowserProvider(browserEnv) === 'brightdata') brightDataBrowserEndpoint(browserEnv);
    }
  }
  catch (error) { return { ok: false, status: 400, error: (error as Error).message }; }
  let directExternalUrl: string | null = null;
  if (request.externalUrl !== undefined) {
    if (trigger !== 'admin') return { ok: false, status: 403, error: 'Only administrators can start a direct website application.' };
    if (mode !== 'live') return { ok: false, status: 400, error: 'A direct website application must be a live run.' };
    if (request.jobIds !== undefined) return { ok: false, status: 400, error: 'Choose either a direct website URL or targeted SEEK jobs, not both.' };
    const checked = await validateExternalJobUrl(request.externalUrl);
    if (typeof checked !== 'string') return { ok: false, status: 400, error: checked.error };
    directExternalUrl = checked;
    overrides.DIRECT_EXTERNAL_JOB_URL = checked;
    overrides.APPLY_ONLY = 'external';
    overrides.MAX_APPS_PER_RUN = '1';
    overrides.MAX_EVALUATIONS = '1';
  }
  if (request.jobIds !== undefined) {
    if (trigger !== 'admin') return { ok: false, status: 403, error: 'Only administrators can target a retry.' };
    if (!Array.isArray(request.jobIds) || !request.jobIds.length || request.jobIds.length > USER_RUN_LIMITS.MAX_APPS_PER_DAY || request.jobIds.some(id => typeof id !== 'string' || !/^\d{6,12}$/.test(id))) {
      return { ok: false, status: 400, error: `Provide between 1 and ${USER_RUN_LIMITS.MAX_APPS_PER_DAY} valid SEEK job IDs.` };
    }
    const ids = [...new Set(request.jobIds)] as string[];
    const jobs = await query<{ job_id: string; title: string; company: string }>(
      `SELECT DISTINCT ON (job_id) job_id, title, company FROM run_events
       WHERE user_id=$1 AND job_id=ANY($2::text[]) AND title<>'' AND company<>'' ORDER BY job_id, ts DESC`, [userId, ids]);
    if (jobs.length !== ids.length) return { ok: false, status: 400, error: 'Targeted retries require an existing job record for this account.' };
    overrides.TARGET_SEEK_JOBS = JSON.stringify(ids.map(id => jobs.find(job => job.job_id === id)!));
    overrides.PLATFORMS = 'seek';
  }

  if (!directExternalUrl && (request.scope === 'external' || request.scope === 'hosted')) {
    // The authenticated admin route may narrow a customer's run as well.
    // Customer entitlements still control employer-site eligibility below.
    if (entitlements.runScopes || trigger === 'admin') overrides.APPLY_ONLY = request.scope;
  }

  if (consumes) {
    try {
      const allowance = await billingStatus(userId, email);
      const unlimitedApplications = allowance.paid.unlimitedApplications === true;
      if (unlimitedApplications && !admin) {
        overrides.APPLICATIONS_UNLIMITED = 'true';
        overrides.MAX_APPS_PER_RUN = 'none';
        // Every account has a daily ceiling, including unlimited passes.
        const chosenDailyCap = String(request.clientOverrides?.MAX_APPS_PER_DAY
          ?? (settingsSnapshot.saved[DAILY_APPLICATION_CAP_CHOSEN] === '1' ? settingsSnapshot.saved.MAX_APPS_PER_DAY : '') ?? '').trim();
        overrides.MAX_APPS_PER_DAY = String(dailyApplicationLimit(chosenDailyCap));
      }
      const externalUsedToday = admin ? 0 : await externalSubmittedToday(userId);
      const externalAvailable = prepaidExternal > 0 || allowance.paid.hasActiveIntensivePass
        && allowance.paid.remaining > 0
        && allowance.paid.employerSiteRemaining > 0
        && (unlimitedApplications || externalUsedToday < INTENSIVE_EMPLOYER_SITES_PER_DAY);
      const externalCeiling = externalUsedToday + Math.min(
        selections ? prepaidExternal : allowance.paid.employerSiteRemaining,
        selections ? prepaidExternal : allowance.paid.remaining,
        Math.max(0, INTENSIVE_EMPLOYER_SITES_PER_DAY - externalUsedToday),
      );
      // Decided from the active pass here, never from a supplied override.
      const employerSitesAllowed = prepaidExternal > 0 || mayRunEmployerSiteApplications({
        targetIsAdmin: admin,
        initiatedByAdmin: trigger === 'admin',
        hasIntensiveAllowance: externalAvailable,
      });
      overrides.ALLOW_EXTERNAL_APPLY = employerSitesAllowed ? 'true' : 'false';
      if (directExternalUrl && overrides.ALLOW_EXTERNAL_APPLY !== 'true') {
        return { ok: false, status: 403, error: 'Direct employer-website testing requires an administrator and an active Get Owtomated pass.' };
      }
      /**
       * Employer-site applications are Get Owtomated feature and cost
       * 10-20x a Quick Apply. An operator of this installation has no
       * ceilings at all: no daily employer-site limit, no allowance
       * deduction, and their own run settings unclamped.
       */
      if (admin) overrides.ADMIN_UNLIMITED = 'true';
      else {
        overrides.MAX_EXTERNAL_PER_DAY = unlimitedApplications ? '' : String(externalCeiling);
        overrides.EXTERNAL_ATTEMPTS_TODAY = String(externalUsedToday);
      }

      if (admin) {
        // No allowance check and no clamp: the operator runs at the size they configured.
      } else {
        const refused = selections ? null : allowanceRefusal(allowance);
        if (refused) return refused;
        // Paid credits already receive a dedicated pooled address. Accounts
        // with only their free allowance borrow one until a submission lands.
        borrowFreeProxy = allowance.paid.remaining < 1 && (allowance.free.remaining > 0 || Boolean(selections));
        if (!selections && !unlimitedApplications) overrides.MAX_APPS_PER_RUN = String(Math.min(Number(overrides.MAX_APPS_PER_RUN || 1), allowance.totalRemaining));
      }
    } catch (error) {
      return { ok: false, status: 503, error: `Could not verify run allowance: ${(error as Error).message}` };
    }
  } else {
    /**
     * A search submits nothing and spends no allowance, but it should review
     * the same jobs a live run would: employer-site listings included for an
     * account that may apply to them. Left unset, a search treated every
     * employer-site listing as "external application disabled", so an
     * employer-sites-only search could never find a job (0 of 191 on 4 Oct).
     */
    const allowance = await billingStatus(userId, email).catch(() => null);
    overrides.ALLOW_EXTERNAL_APPLY = mayRunEmployerSiteApplications({
      targetIsAdmin: admin,
      initiatedByAdmin: trigger === 'admin',
      hasIntensiveAllowance: Boolean(allowance?.paid.hasActiveIntensivePass),
    }) ? 'true' : 'false';
  }

  /**
   * A run that could not submit anything is refused, not started.
   *
   * The bot checks the daily limit as it starts and stops at once, so a run
   * begun with the limit already reached finished in under a second with
   * nothing to show — it looked stalled, and it spent a run from the day's
   * allowance and a scheduled slot. Counted in the candidate's own day, the
   * same count the dashboard shows as "sent today".
   */
  if (consumes) {
    const limit = dailyApplicationLimit(overrides.MAX_APPS_PER_DAY);
    const sent = await submittedToday(userId).catch(() => 0);
    if (Number.isFinite(limit) && sent >= limit) {
      return {
        ok: false,
        status: 429,
        error: `Today's limit of ${limit} applications is reached (${sent} sent). Runs resume tomorrow${entitlements.fineTune ? ', or raise the daily application cap in the run settings' : ''}.`,
      };
    }
  }

  /**
   * The run needs the account's browser profile to itself.
   *
   * A person still signing in keeps it for now if the scheduler is asking;
   * if they pressed Start themselves, they are done signing in. Sign-in
   * checks already going are waited for; only then is anything else holding
   * the profile a browser nobody is using any more.
   */
  if (needsBrowser && sessionFor(userId)) {
    // Only the account holder pressing Start ends their own sign-in; nobody else closes a window they are using.
    if (trigger !== 'manual') return { ok: false, status: 409, error: 'A sign-in is in progress for this account.' };
    await stopSignin(userId);
  }

  if (needsBrowser) {
    const browserReady = await waitForSigninChecks(userId);
    if (!browserReady.ok) return { ok: false, status: 409, error: browserReady.error };
  }

  /**
   * Only boards this account is signed in to.
   *
   * A board not confirmed signed in cannot be searched or applied on, so it
   * is left out of the run and the run says so. With no signed-in board left there is
   * nothing to run, and the reason is given instead of an empty run.
   */
  const boards = directExternalUrl || emailOnly
    ? []
    : (overrides.PLATFORMS || 'seek').split(',').map((board) => board.trim()).filter(Boolean);
  /**
   * A board last seen signed out gets one fresh check before it is written
   * off. The check signs a lapsed session back in with the account the
   * browser already holds, so a session that expired overnight costs a minute
   * here instead of every run until a person notices.
   */
  for (const board of boards) {
    if (board !== 'seek' && board !== 'indeed') continue;
    const state = readSiteState(userId, board);
    // An unknown state may still have valid cookies (for example after a
    // migration or restored browser profile), so verify it instead of
    // silently dropping the board. A board the person explicitly signed out
    // of stays out until they sign in again.
    if (!state || (state.signedIn === false && !state.signedOutByPerson)) await checkSignin(userId, board);
  }
  const { supported: supportedBoards, unavailable, usable } = availableJobSources(boards, admin, board => readSiteState(userId, board)?.signedIn === true);
  if (!directExternalUrl && usable.length && usable.every(isEmployerSource) && overrides.APPLY_ONLY === 'hosted') {
    return { ok: false, status: 400, error: 'Employer feeds use employer-site applications. Choose a normal or employer-sites run.' };
  }
  if (consumes && !directExternalUrl && !emailOnly && !usable.length) {
    return {
      ok: false,
      status: 428,
      error: `${listNames(unavailable.length ? unavailable : supportedBoards)} ${unavailable.length === 1 ? 'is' : 'are'} not confirmed signed in. Sign in on the Apply page, then start the run again.`,
    };
  }
  if (!directExternalUrl && !emailOnly) overrides.PLATFORMS = usable.join(',');
  if (unavailable.length) overrides.SKIPPED_BOARDS = unavailable.join(',');

  /**
   * The run's record is made first, so the runner can write how it ended onto
   * it, and removed again if the start is refused.
   *
   * A refused start — the pool was full, or this account was already running
   * — never reached an employer, so it must not spend a slot; the scheduler
   * simply tries again on its next tick. The allowance counts a normal
   * completion or confirmed submissions, independently of process health;
   * an unsuccessful empty attempt remains eligible for a retry.
   */
  let started = false;
  let approved: PreparedApplication[] = [];
  try {
    if (selections) {
      if (selections.length > Number(overrides.MAX_APPS_PER_RUN === 'none' ? Infinity : overrides.MAX_APPS_PER_RUN)) {
        return { ok: false, status: 400, error: `Confirm at most ${overrides.MAX_APPS_PER_RUN} applications in one run.` };
      }
      try { approved = await claimApplicationReviews(userId, selections); }
      catch (error) {
        if (error instanceof ApplicationReviewError) return { ok: false, status: 409, error: error.message };
        throw error;
      }
      const permitted = new Set((overrides.PLATFORMS || 'seek').split(','));
      if (approved.some(item => !permitted.has(item.job.platform ?? 'seek'))) return { ok: false, status: 403, error: 'One of these applications uses a job board outside your current settings or plan.' };
      overrides.PLATFORMS = [...new Set(approved.map(item => item.job.platform ?? 'seek'))].join(',');
      overrides.APPLICATION_REVIEW_MODE = 'approved';
      overrides.APPROVED_APPLICATIONS_JSON = JSON.stringify(approved);
      overrides.MAX_APPS_PER_RUN = String(approved.length);
      overrides.MAX_EVALUATIONS = String(approved.length);
    }
    // Decided as late as possible, so the run starts on the route that is up now rather than a minute ago.
    if (needsBrowser) {
      const route = await browserRoute(userId, borrowFreeProxy);
      if (route.proxyServer) {
        overrides.BROWSER_PROXY_SERVER = route.proxyServer;
        overrides.BROWSER_ROUTE_NOTE = describeRoute(route.status);
      }
    }

    const launch = async (): Promise<StartRunOutcome> => {
      const runStartId = await recordRunStart(userId, mode, effectiveTrigger, request.startedBy, request.initiatorDevice, Boolean(selections));
      if (!runStartId) throw new Error('Could not save the run start.');
      const result = await runner.start(
        mode,
        overrides,
        userId,
        mode === 'live' && !admin && !selections
          ? async (external) => {
              let usageError: unknown = null;
              try {
                await consumeSuccessfulApplication(userId, external);
              } catch (error) {
                usageError = error;
              }
              try {
                // The runner calls this only after it has confirmed submission. A
                // free loan is returned; a paid user's dedicated proxy is a no-op.
                await releaseFreeProxy(userId);
              } catch (releaseError) {
                if (!usageError) throw releaseError;
              }
              if (usageError) throw usageError;
            }
          : undefined,
        borrowFreeProxy
          ? async () => {
              // Also return a loan when the run finishes without submitting,
              // fails, or is stopped. Paid assignments are ignored by this call.
              await releaseFreeProxy(userId);
            }
          : undefined,
        runStartId,
        // Diagnostic searches must not rewrite the account's next-run keywords.
        mode === 'live' && !selections ? {
          termsUsed: overrides.KEYWORDS ?? '',
          expectedSavedTerms: settingsSnapshot.saved.KEYWORDS ?? '',
        } : undefined,
      );
      if (!result.ok) {
        await discardRunStart(runStartId).catch(() => {});
        return { ok: false, status: /already|in progress|being prepared|installing an update/i.test(result.error ?? '') ? 409 : 503, error: result.error ?? 'Could not start the run.' };
      }

      started = true;
      return { ok: true, mode };
    };
    if (trigger === 'auto') {
      return await scheduledStart(userId, request.scheduleGeneration!, request.applicationMode!, entitlements.autoRunsPerDay, launch)
        ?? { ok: false, status: 409, error: 'The schedule was paused or this slot is no longer due.' };
    }
    return await launch();
  } finally {
    if (!started && approved.length) await releaseApplicationReviews(userId, approved.map(item => item.id), selections ?? []);
    // Route selection happens before the runner reserves a slot. Any failure
    // between those two points must return the loan as well.
    if (borrowFreeProxy && !started) await releaseFreeProxy(userId).catch(() => {});
  }
}
