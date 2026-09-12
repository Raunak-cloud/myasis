import { runner, type RunMode } from './runner.js';
import { runSettingsForUser, KEEP_SETTINGS_KEYS } from './settings.js';
import {
  billingStatus,
  consumeCompletedRehearsal,
  consumeSuccessfulApplication,
  isAdmin,
} from './billing.js';
import { applyRunPolicy, entitlementsFor, recordRunStart, FINE_TUNING_KEYS } from './entitlements.js';
import { listResumes } from './files.js';

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
  /** Who asked: a person, or the scheduler. */
  trigger: 'manual' | 'auto';
  /** Settings posted with the request. Ignored for scheduled runs. */
  clientOverrides?: Record<string, unknown>;
}

export async function startRun(request: StartRunRequest): Promise<StartRunOutcome> {
  const { userId, email, mode, trigger } = request;
  const admin = isAdmin(email);
  const entitlements = await entitlementsFor(userId, email);
  const consumes = mode === 'live' || mode === 'rehearse';

  /**
   * Whether this account drives runs at all, checked before anything else.
   *
   * The UI hides these controls for a standard account, but hiding a button
   * is not a rule — this is.
   */
  if (trigger === 'manual' && consumes) {
    if (!entitlements.manualRuns) {
      return {
        ok: false,
        status: 403,
        error: 'Your plan applies automatically. Rehearsals and manual runs are part of the Intensive Pass.',
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
      error: 'Upload your résumé first — applications are built from it.',
    };
  }

  const overrides = applyRunPolicy(
    await runSettingsForUser(userId, { unlimited: admin }),
    entitlements,
    trigger,
  );

  /**
   * Only known per-account settings are accepted from a browser: without this
   * filter a request could set PROFILE_PATH or DATA_DIR and point its own run
   * at another account's files. An account that may not fine-tune cannot post
   * the behaviour settings either, whatever its UI is showing.
   */
  for (const [key, value] of Object.entries(request.clientOverrides ?? {})) {
    if (trigger !== 'manual') break;
    if (!KEEP_SETTINGS_KEYS.includes(key as (typeof KEEP_SETTINGS_KEYS)[number])) continue;
    if (!entitlements.fineTune && FINE_TUNING_KEYS.includes(key)) continue;
    if (value !== undefined && value !== null && String(value).length) overrides[key] = String(value);
  }

  let countRehearsals = false;
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
      else overrides.MAX_EXTERNAL_PER_DAY = allowance.paid.hasActiveIntensivePass ? '5' : '0';

      if (admin) {
        // No allowance check and no clamp: the operator runs at the size they configured.
      } else if (mode === 'live') {
        if (allowance.totalRemaining < 1) {
          return {
            ok: false,
            status: 402,
            error: 'No successful applications remain. Choose a pass or wait for the free allowance to reset.',
          };
        }
        overrides.MAX_APPS_PER_RUN = String(Math.min(Number(overrides.MAX_APPS_PER_RUN || 1), allowance.totalRemaining));
      } else if (!allowance.rehearsals.unlimited) {
        if (allowance.rehearsals.remaining < 1) {
          return {
            ok: false,
            status: 402,
            error: 'No free rehearsals remain this month. Choose a pass for unlimited rehearsals or wait for the monthly reset.',
          };
        }
        overrides.MAX_APPS_PER_RUN = String(Math.min(Number(overrides.MAX_APPS_PER_RUN || 1), allowance.rehearsals.remaining));
        countRehearsals = true;
      }
    } catch (error) {
      return { ok: false, status: 503, error: `Could not verify run allowance: ${(error as Error).message}` };
    }
  }

  const result = await runner.start(
    mode,
    overrides,
    userId,
    mode === 'live' && !admin ? () => consumeSuccessfulApplication(userId) : undefined,
    countRehearsals && !admin ? () => consumeCompletedRehearsal(userId) : undefined,
  );
  if (!result.ok) return { ok: false, status: 409, error: result.error ?? 'Could not start the run.' };

  /**
   * Recorded once the child is actually spawned.
   *
   * A refused start — the pool was full, or this account was already running
   * — never reached an employer, so it must not spend a slot; the scheduler
   * simply tries again on its next tick. A run that starts and then dies
   * does count, which is why this is not tied to the run finishing.
   */
  if (consumes) await recordRunStart(userId, mode, trigger).catch(() => {});

  return { ok: true, mode };
}
