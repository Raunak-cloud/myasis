import { runner, type RunMode } from './runner.js';
import { runSettingsSnapshotForUser, USER_SETTABLE_SETTINGS_KEYS } from './settings.js';
import {
  billingStatus,
  consumeSuccessfulApplication,
  isAdmin,
  type BillingStatus,
} from './billing.js';
import {
  applyRunPolicy,
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
import { releaseChromeProfile } from './chrome-profile.js';
import { userChromeDir } from './userdata.js';
import { externalSubmittedToday, submittedToday } from './today.js';
import { readSiteState } from './seek-state.js';
import { browserRoute, describeRoute } from './route.js';
import { releaseFreeProxy } from './proxy-pool.js';
import { query } from './db/index.js';
import { validateExternalJobUrl } from './external-job-url.js';
import { mayRunEmployerSiteApplications } from './employer-site-access.js';

const BOARD_NAMES: Record<string, string> = { seek: 'SEEK', indeed: 'Indeed' };
const listNames = (boards: string[]) => boards.map((board) => BOARD_NAMES[board] ?? board).join(' and ');

/** The daily limit a run will enforce, resolved exactly as seek-bot's config does. */
function dailyLimit(overrides: Record<string, string>): number {
  if (overrides.MAX_APPS_PER_DAY === 'none' && overrides.ADMIN_UNLIMITED === 'true') return Infinity;
  const wanted = Number(overrides.MAX_APPS_PER_DAY || 20);
  if (!Number.isFinite(wanted)) return 20;
  return Math.max(1, overrides.ADMIN_UNLIMITED === 'true' ? Math.floor(wanted) : Math.min(50, wanted));
}

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
  /**
   * Who asked: the account holder, the scheduler, or an admin acting for the
   * account. An admin's run follows the account's plan exactly as a scheduled
   * run does, and does not use up one of the account's scheduled runs.
   */
  trigger: 'manual' | 'auto' | 'admin' | 'onboarding';
  /** The admin who started it, for the record. */
  startedBy?: string | null;
  /** Settings posted with the request. Ignored for scheduled runs. */
  clientOverrides?: Record<string, unknown>;
  /** Limit the run to one kind of application. Honoured only for accounts entitled to it. */
  scope?: unknown;
  /** Admin diagnostic retries, still subject to normal eligibility and limits. */
  jobIds?: unknown;
  /** One exact employer job page supplied by an administrator. */
  externalUrl?: unknown;
}

type Refusal = Extract<StartRunOutcome, { ok: false }>;

/** Why this account may not start a run by hand, or null for an administrator. */
export function manualRunRefusal(entitlements: Pick<Entitlements, 'manualRuns' | 'firstRunRequired'>): Refusal | null {
  if (!entitlements.manualRuns && !entitlements.firstRunRequired) {
    return { ok: false, status: 403, error: 'Only administrators can start runs manually.' };
  }
  return null;
}

/** A live run needs at least one application left to spend. The free allowance is given once, so there is nothing to wait for. */
export function allowanceRefusal(allowance: Pick<BillingStatus, 'totalRemaining'>): Refusal | null {
  return allowance.totalRemaining < 1
    ? { ok: false, status: 402, error: 'No successful applications remain. Choose a pass to keep applying.' }
    : null;
}

export async function startRun(request: StartRunRequest): Promise<StartRunOutcome> {
  const { userId, email, mode, trigger } = request;
  const admin = isAdmin(email);
  let borrowFreeProxy = false;
  const entitlements = await entitlementsFor(userId, email);
  const onboarding = trigger === 'manual' && !admin && entitlements.firstRunRequired;
  const effectiveTrigger = onboarding ? 'onboarding' : trigger;
  /** A search-only run never reaches an employer; a live run submits applications. */
  const consumes = mode === 'live';

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

  /**
   * Nothing works without one. The agent attaches a résumé on nearly every
   * form, the fit check reads it, and the cover letter is written from it —
   * so a run without one wastes an employer's time and the candidate's
   * allowance before failing on the document step.
   */
  if (consumes && !(await listResumes(userId)).length) {
    return {
      ok: false,
      status: 400,
      error: 'Upload your résumé first. Applications are built from it.',
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
    if (trigger !== 'manual') break;
    if (!USER_SETTABLE_SETTINGS_KEYS.includes(key as (typeof USER_SETTABLE_SETTINGS_KEYS)[number])) continue;
    if (!mayEditRunSetting(key, entitlements)) continue;
    if (value !== undefined && value !== null && String(value).length) settings[key] = String(value);
  }

  /**
   * The plan decides last.
   *
   * Posted settings used to be merged after the plan was applied, and the
   * review screen posts every saved run setting — including the default of 40
   * jobs to evaluate — so an Intensive Pass sold as 80 jobs a run reviewed 40,
   * and the Indeed board its pass includes was dropped whenever the account
   * had not picked boards itself.
   */
  const overrides = applyRunPolicy(settings, entitlements, effectiveTrigger === 'manual' ? 'manual' : 'auto');
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
    if (!Array.isArray(request.jobIds) || !request.jobIds.length || request.jobIds.length > 10 || request.jobIds.some(id => typeof id !== 'string' || !/^\d{6,12}$/.test(id))) {
      return { ok: false, status: 400, error: 'Provide between 1 and 10 valid SEEK job IDs.' };
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
      const externalUsedToday = admin ? 0 : await externalSubmittedToday(userId);
      const externalAvailable = allowance.paid.hasActiveIntensivePass
        && allowance.paid.remaining > 0
        && allowance.paid.employerSiteRemaining > 0
        && externalUsedToday < INTENSIVE_EMPLOYER_SITES_PER_DAY;
      const externalCeiling = externalUsedToday + Math.min(
        allowance.paid.employerSiteRemaining,
        allowance.paid.remaining,
        Math.max(0, INTENSIVE_EMPLOYER_SITES_PER_DAY - externalUsedToday),
      );
      // Decided here, never from a supplied override. Employer-site support is
      // still in operator testing: an Intensive customer's own scheduled run
      // cannot reach it until the customer launch gate is deliberately opened.
      const employerSitesAllowed = mayRunEmployerSiteApplications({
        targetIsAdmin: admin,
        initiatedByAdmin: trigger === 'admin',
        hasIntensiveAllowance: externalAvailable,
      });
      overrides.ALLOW_EXTERNAL_APPLY = employerSitesAllowed ? 'true' : 'false';
      if (directExternalUrl && overrides.ALLOW_EXTERNAL_APPLY !== 'true') {
        return { ok: false, status: 403, error: 'Direct employer-website testing requires an administrator and an active Intensive Pass.' };
      }
      /**
       * Employer-site applications are an Intensive Pass feature and cost
       * 10-20x a Quick Apply. An operator of this installation has no
       * ceilings at all: no daily employer-site limit, no allowance
       * deduction, and their own run settings unclamped.
       */
      if (admin) overrides.ADMIN_UNLIMITED = 'true';
      else {
        overrides.MAX_EXTERNAL_PER_DAY = String(externalCeiling);
        overrides.EXTERNAL_ATTEMPTS_TODAY = String(externalUsedToday);
      }

      if (admin) {
        // No allowance check and no clamp: the operator runs at the size they configured.
      } else {
        const refused = allowanceRefusal(allowance);
        if (refused) return refused;
        // Paid credits already receive a dedicated pooled address. Accounts
        // with only their free allowance borrow one until a submission lands.
        borrowFreeProxy = allowance.paid.remaining < 1 && allowance.free.remaining > 0;
        overrides.MAX_APPS_PER_RUN = String(Math.min(Number(overrides.MAX_APPS_PER_RUN || 1), allowance.totalRemaining));
      }
    } catch (error) {
      return { ok: false, status: 503, error: `Could not verify run allowance: ${(error as Error).message}` };
    }
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
    const limit = dailyLimit(overrides);
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
   * if they pressed Start themselves, they are done signing in. Anything
   * else holding the profile is a browser nobody is using any more.
   */
  if (sessionFor(userId)) {
    // Only the account holder pressing Start ends their own sign-in; nobody else closes a window they are using.
    if (trigger !== 'manual') return { ok: false, status: 409, error: 'A sign-in is in progress for this account.' };
    stopSignin(userId);
  }
  await releaseChromeProfile(userChromeDir(userId));

  const browserReady = await waitForSigninChecks(userId);
  if (!browserReady.ok) return { ok: false, status: 409, error: browserReady.error };

  /**
   * Only boards this account is signed in to.
   *
   * A board not confirmed signed in cannot be searched or applied on, so it
   * is left out of the run and the run says so. With no signed-in board left there is
   * nothing to run, and the reason is given instead of an empty run.
   */
  const boards = directExternalUrl
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
  const supportedBoards = boards.filter((board) => board === 'seek' || board === 'indeed');
  const unavailable = supportedBoards.filter((board) => readSiteState(userId, board)?.signedIn !== true);
  const usable = supportedBoards.filter((board) => readSiteState(userId, board)?.signedIn === true);
  if (consumes && !directExternalUrl && !usable.length) {
    return {
      ok: false,
      status: 428,
      error: `${listNames(unavailable.length ? unavailable : supportedBoards)} ${unavailable.length === 1 ? 'is' : 'are'} not confirmed signed in. Sign in on the Apply page, then start the run again.`,
    };
  }
  if (!directExternalUrl) overrides.PLATFORMS = usable.join(',');
  if (unavailable.length) overrides.SKIPPED_BOARDS = unavailable.join(',');

  /**
   * The run's record is made first, so the runner can write how it ended onto
   * it, and removed again if the start is refused.
   *
   * A refused start — the pool was full, or this account was already running
   * — never reached an employer, so it must not spend a slot; the scheduler
   * simply tries again on its next tick. The runner marks this durable record
   * successful only after the bot reaches its normal completion checkpoint,
   * so a run that starts and then fails is also eligible for a retry.
   */
  let started = false;
  try {
    // Decided as late as possible, so the run starts on the route that is up now rather than a minute ago.
    const route = await browserRoute(userId, borrowFreeProxy);
    if (route.proxyServer) {
      overrides.BROWSER_PROXY_SERVER = route.proxyServer;
      overrides.BROWSER_ROUTE_NOTE = describeRoute(route.status);
    }

    const runStartId = await recordRunStart(userId, mode, effectiveTrigger, request.startedBy).catch(() => null);
    const result = await runner.start(
      mode,
      overrides,
      userId,
      mode === 'live' && !admin
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
      {
        termsUsed: overrides.KEYWORDS ?? '',
        expectedSavedTerms: settingsSnapshot.saved.KEYWORDS ?? '',
      },
    );
    if (!result.ok) {
      await discardRunStart(runStartId).catch(() => {});
      return { ok: false, status: 409, error: result.error ?? 'Could not start the run.' };
    }

    started = true;
    return { ok: true, mode };
  } finally {
    // Route selection happens before the runner reserves a slot. Any failure
    // between those two points must return the loan as well.
    if (borrowFreeProxy && !started) await releaseFreeProxy(userId).catch(() => {});
  }
}
