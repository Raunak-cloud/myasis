import type { Page } from 'patchright';
import { hasVisibleCaptcha } from '../browser.js';
import { config } from '../config.js';
import { CostMeter } from './celeris.js';

/**
 * Deterministic rails the agent cannot argue its way past.
 *
 * The point of this file: replacing the hand-written state machine with a
 * model changes *how we navigate*, and nothing else. Whether an application is
 * allowed to be transmitted, whether we stop at a CAPTCHA, whether we follow a
 * link off SEEK, and how long a run may spend are all decided here, in code,
 * before or after the model speaks — never by it.
 *
 * Nothing in this module takes model output as an input.
 */

const clean = (s: string) => s.replace(/[​-‍⁠﻿ ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Controls that can transmit an application.
 *
 * SEEK uses "Review and submit" as the terminal action on some one-page
 * applications rather than navigating to a separate /review page, so every
 * submit-labelled action is treated as terminal. A rehearsal must never click
 * one, whatever the agent believes it is doing.
 */
const SUBMIT_LABELS =
  /^(review and submit|review your application|submit application|submit|send application|apply now|finish application|complete application)$/i;

export function isSubmitAction(text: string): boolean {
  return SUBMIT_LABELS.test(clean(text).toLowerCase());
}

export function isExternal(url: string): boolean {
  if (/\/apply\/external/i.test(url)) return true;
  try {
    return !/(^|\.)seek\.com\.au$|(^|\.)seek\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Pages the agent is never allowed to drive, whatever it decides.
 *
 * The bot does not automate login and does not handle credentials — that is a
 * standing guarantee of this project, so it is enforced rather than prompted.
 */
const FORBIDDEN_URL = /\/(login|signin|sign-in|register|signup|password|oauth|checkout|payment|billing)\b/i;

export function isForbiddenDestination(url: string): boolean {
  return FORBIDDEN_URL.test(url);
}

/**
 * Cheap deterministic friction detection — no model call.
 *
 * Identity detection stays conservative: SEEK renders a *non-blocking* "verify
 * with SEEK Pass" upsell beside ordinary work-rights questions, and naive text
 * matching reads that as a wall and aborts a perfectly good application. A
 * mention only counts when there is genuinely no way forward.
 */
export async function detectFriction(page: Page): Promise<'captcha' | 'identity' | null> {
  if (/seekpass|verify-identity|right-to-work/i.test(page.url())) return 'identity';

  if (await hasVisibleCaptcha(page)) return 'captcha';

  const body = await page.locator('body').innerText().catch(() => '');
  if (/i'?m not a robot|select all (images|squares)|verify you are human/i.test(body)) return 'captcha';

  /**
   * "…to continue applying" is SEEK stating outright that the listing is gated
   * on verified work rights. The Continue button stays *enabled* on those
   * pages — clicking it bounces you back — so button state is not a reliable
   * signal and the wording has to be trusted instead.
   */
  if (/verify your (work rights|identity)[^.]{0,40}to continue/i.test(body)) return 'identity';

  if (/seek pass|verify your (work rights|identity)/i.test(body)) {
    const enabled = await page
      .locator('button:visible, a[role="button"]:visible')
      .filter({ hasText: /continue|next|submit|review/i })
      .first()
      .isEnabled()
      .catch(() => false);
    if (!enabled) return 'identity';
  }
  return null;
}

/**
 * Whether the application actually went through.
 *
 * Checked before any friction check, deliberately: SEEK renders a SEEK Pass
 * upsell on its own confirmation page, which the friction detector reads as a
 * wall. Reporting a submitted application as `needs-human` leaves it
 * unrecorded and sets up a duplicate application on the next run.
 */
export async function detectConfirmation(page: Page): Promise<boolean> {
  if (/\/apply\/success/.test(page.url())) return true;

  // On SEEK, only its dedicated success URL is proof: application forms and
  // employer copy can contain "application received" before anything is sent.
  try {
    if (/(^|\.)seek\.com\.au$/i.test(new URL(page.url()).hostname)) return false;
  } catch {
    return false;
  }

  const body = await page.locator('body').innerText().catch(() => '');
  const confirmationCopy =
    /(application (has been|was) (sent|submitted)|your application was sent|nice work,|thanks for applying|application received)/i.test(
      body,
    );
  if (!confirmationCopy) return false;

  // External ATSs share no stable success URL, so their copy is only trusted
  // once the form and every forward action have disappeared.
  const hasForm =
    (await page.locator('form input:visible, form textarea:visible, form select:visible').count().catch(() => 0)) > 0;
  if (hasForm) return false;
  const hasAdvance = await page
    .locator('button:visible, a[role="button"]:visible')
    .filter({ hasText: /continue|next|submit|review/i })
    .count()
    .catch(() => 0);
  return hasAdvance === 0;
}

export type SubmitVerdict =
  | { allowed: true }
  | { allowed: false; kind: 'dry-run' | 'ungrounded' | 'off-platform'; reason: string };

export interface RunGuardOptions {
  maxSteps: number;
  /**
   * How long the agent may go without getting anywhere.
   *
   * Deliberately not a total time limit. A slow multi-page employer form that
   * keeps moving forward should be allowed to finish; what must be stopped is
   * an agent going in circles, because that burns money and blocks every job
   * behind it. So the clock measures time since the last real progress and is
   * reset whenever the page moves or a form actually gets filled in.
   */
  maxStuckMs: number;
  /** Last-resort ceiling, in case something loops while looking like progress. */
  maxTotalMs: number;
  meter: CostMeter;
}

export type BudgetVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Per-application budget and grounding ledger.
 *
 * An agent loop has no fixed step count, so every one of these ceilings is
 * load-bearing: without them an unrecognised page becomes an unbounded spend
 * and an unbounded number of clicks on a real employer's site.
 */
export class RunGuards {
  private steps = 0;
  private readonly startedAt = Date.now();
  private lastProgressAt = Date.now();
  /** Questions the grounded-answer path refused to stand behind. */
  readonly ungrounded: string[] = [];

  constructor(private readonly options: RunGuardOptions) {}

  /** Called once per agent turn. */
  nextStep(): BudgetVerdict {
    this.steps += 1;
    if (this.steps > this.options.maxSteps) {
      return { ok: false, reason: `step budget exhausted (${this.options.maxSteps} steps)` };
    }
    const stuckFor = Date.now() - this.lastProgressAt;
    if (stuckFor > this.options.maxStuckMs) {
      return { ok: false, reason: `stuck for ${Math.round(stuckFor / 1000)}s with no progress` };
    }
    const elapsed = Date.now() - this.startedAt;
    if (elapsed > this.options.maxTotalMs) {
      return { ok: false, reason: `overall time limit reached (${Math.round(elapsed / 1000)}s)` };
    }
    if (this.options.meter.exhausted) {
      return { ok: false, reason: `model budget exhausted (${this.options.meter.summary()})` };
    }
    return { ok: true };
  }

  get stepCount(): number {
    return this.steps;
  }

  /**
   * Something actually moved: the page changed, or a form was filled in.
   * Filling fields counts even though the page looks the same afterwards —
   * answering six questions is progress, and timing out mid-form would be
   * exactly the wrong call.
   */
  recordProgress(): void {
    this.lastProgressAt = Date.now();
  }

  resolveGrounding(question: string): void {
    const i = this.ungrounded.indexOf(question);
    if (i >= 0) this.ungrounded.splice(i, 1);
  }

  readonly pendingFields = new Set<string>();

  recordUngrounded(question: string): void {
    if (!this.ungrounded.includes(question)) this.ungrounded.push(question);
  }

  /**
   * The final gate. Every path to transmitting an application goes through
   * here, and it consults only configuration and recorded facts.
   */
  canSubmit(currentUrl: string): SubmitVerdict {
    if (this.pendingFields.size) return { allowed: false, kind: 'ungrounded', reason: `Fields not verified: ${[...this.pendingFields].join('; ')}` };
    if (this.ungrounded.length) {
      return {
        allowed: false,
        kind: 'ungrounded',
        reason: `the model could not ground ${this.ungrounded.length} answer(s): ${this.ungrounded
          .slice(0, 3)
          .join('; ')}`,
      };
    }
    if (isExternal(currentUrl) && !config.allowExternalApply) {
      return { allowed: false, kind: 'off-platform', reason: `submit is on an external site (${currentUrl})` };
    }
    /**
     * Read the environment live, not just the snapshot config took at import.
     *
     * This cost a real application. `e2e.ts` sets `process.env.DRY_RUN='true'`
     * at the top of the file and then imports config — but ES imports are
     * hoisted, so config had already evaluated against a `.env` saying
     * `DRY_RUN=false`. The rehearsal ran with the withhold guard silently
     * disarmed and submitted to a live employer.
     *
     * A safety rail must not be defeatable by module ordering, so this consults
     * both and blocks if *either* says rehearsal.
     */
    if (config.dryRun || process.env.DRY_RUN === 'true') {
      return { allowed: false, kind: 'dry-run', reason: 'DRY_RUN — final submit withheld' };
    }
    return { allowed: true };
  }
}
