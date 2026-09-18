import { runner, type RunMode } from './runner.js';
import { runSettingsForUser, USER_SETTABLE_SETTINGS_KEYS } from './settings.js';
import {
  billingStatus,
  consumeSuccessfulApplication,
  isAdmin,
} from './billing.js';
import {
  applyRunPolicy,
  discardRunStart,
  entitlementsFor,
  recordRunStart,
  FINE_TUNING_KEYS,
  INTENSIVE_EMPLOYER_SITES_PER_DAY,
} from './entitlements.js';
import { listResumes } from './files.js';
import { waitForSigninChecks } from './seek-check.js';
import { sessionFor, stopSignin } from './signin.js';
import { releaseChromeProfile } from './chrome-profile.js';
import { userChromeDir } from './userdata.js';
import { submittedToday } from './today.js';
import { readSiteState } from './seek-state.js';

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

export type StartRunOutcome =
  | { ok: true; mode: RunMode }
  | { ok: false; status: number; error: string };

export interface StartRunRequest {
  userId: string;
  email?: string | null;
  mode: RunMode;
  /**
   * Who asked: the account holder, the scheduler, or an admin acting for the
   * account. An admin's run follows the account's plan exactly as a scheduled
   * run does, and does not use up the account's own manual or scheduled runs.
   */
  trigger: 'manual' | 'auto' | 'admin';
  /** The admin who started it, for the record. */
  startedBy?: string | null;
  /** Settings posted with the request. Ignored for scheduled runs. */
  clientOverrides?: Record<string, unknown>;
  /** Limit the run to one kind of application. Honoured only for accounts entitled to it. */
  scope?: unknown;
}

export async function startRun(request: StartRunRequest): Promise<StartRunOutcome> {
  const { userId, email, mode, trigger } = request;
  const admin = isAdmin(email);
  const entitlements = await entitlementsFor(userId, email);
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
    if (!entitlements.manualRuns) {
      return {
        ok: false,
        status: 403,
        error: 'Your plan applies automatically. Manual runs are part of the Intensive Pass.',
      };
    }
    if (entitlements.manualRunsLeftToday !== null && entitlements.manualRunsLeftToday < 1) {
      return {
        ok: false,
        status: 429,
        error: `You have used all ${entitlements.manualRunsPerDay} runs for today. They reset at midnight.`,
      };
    }
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

  const settings = await runSettingsForUser(userId, { unlimited: admin });

  /**
   * Only known per-account settings are accepted from a browser: without this
   * filter a request could set PROFILE_PATH or DATA_DIR and point its own run
   * at another account's files. An account that may not fine-tune cannot post
   * the behaviour settings either, whatever its UI is showing.
   */
  for (const [key, value] of Object.entries(request.clientOverrides ?? {})) {
    if (trigger !== 'manual') break;
    if (!USER_SETTABLE_SETTINGS_KEYS.includes(key as (typeof USER_SETTABLE_SETTINGS_KEYS)[number])) continue;
    if (!entitlements.fineTune && FINE_TUNING_KEYS.includes(key)) continue;
    if (value !== undefined && value !== null && String(value).length) settings[key] = String(value);
  }

  /**
   * The plan decides last.
   *
   * Posted settings used to be merged after the plan was applied, and the
   * review screen posts every saved run setting — including the default of 40
   * jobs to evaluate — so an Intensive Pass sold as 100 jobs a run reviewed 40,
   * and the Indeed board its pass includes was dropped whenever the account
   * had not picked boards itself.
   */
  const overrides = applyRunPolicy(settings, entitlements, trigger === 'manual' ? 'manual' : 'auto');

  if (request.scope === 'external' || request.scope === 'hosted') {
    if (entitlements.runScopes) overrides.APPLY_ONLY = request.scope;
  }

  if (consumes) {
    try {
      const allowance = await billingStatus(userId, email);
      // Decided here, never from a supplied override.
      overrides.ALLOW_EXTERNAL_APPLY = admin || allowance.paid.hasActiveIntensivePass ? 'true' : 'false';
      /**
       * Employer-site applications are an Intensive Pass feature and cost
       * 10-20x a Quick Apply. An operator of this installation has no
       * ceilings at all: no daily employer-site limit, no allowance
       * deduction, and their own run settings unclamped.
       */
      if (admin) overrides.ADMIN_UNLIMITED = 'true';
      else overrides.MAX_EXTERNAL_PER_DAY = allowance.paid.hasActiveIntensivePass ? String(INTENSIVE_EMPLOYER_SITES_PER_DAY) : '0';

      if (admin) {
        // No allowance check and no clamp: the operator runs at the size they configured.
      } else {
        if (allowance.totalRemaining < 1) {
          return {
            ok: false,
            status: 402,
            error: 'No successful applications remain. Choose a pass or wait for the free allowance to reset.',
          };
        }
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
   * A board last seen signed out cannot be searched or applied on, so it is
   * left out of the run and the run says so; a board never checked is left
   * in for the run to find out. With no signed-in board left there is
   * nothing to run, and the reason is given instead of an empty run.
   */
  const boards = (overrides.PLATFORMS || 'seek').split(',').map((board) => board.trim()).filter(Boolean);
  const signedOut = boards.filter((board) => (board === 'seek' || board === 'indeed') && readSiteState(userId, board)?.signedIn === false);
  const usable = boards.filter((board) => !signedOut.includes(board));
  if (consumes && !usable.length) {
    return {
      ok: false,
      status: 428,
      error: `${listNames(signedOut)} ${signedOut.length === 1 ? 'is' : 'are'} not signed in. Sign in on the Apply page, then start the run again.`,
    };
  }
  overrides.PLATFORMS = usable.join(',');
  if (signedOut.length) overrides.SKIPPED_BOARDS = signedOut.join(',');

  /**
   * The run's record is made first, so the runner can write how it ended onto
   * it, and removed again if the start is refused.
   *
   * A refused start — the pool was full, or this account was already running
   * — never reached an employer, so it must not spend a slot; the scheduler
   * simply tries again on its next tick. A run that starts and then dies
   * does count, which is why this is not tied to the run finishing.
   */
  const runStartId = await recordRunStart(userId, mode, trigger, request.startedBy).catch(() => null);
  const result = await runner.start(
    mode,
    overrides,
    userId,
    mode === 'live' && !admin ? () => consumeSuccessfulApplication(userId) : undefined,
    runStartId,
  );
  if (!result.ok) {
    await discardRunStart(runStartId).catch(() => {});
    return { ok: false, status: 409, error: result.error ?? 'Could not start the run.' };
  }

  return { ok: true, mode };
}
