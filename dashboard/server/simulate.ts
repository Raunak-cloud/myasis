import { paymentsConfigured, type BillingStatus } from './billing.js';
import { deriveEntitlements, FREE_SEARCH_TERM_SUGGESTIONS, type Entitlements } from './entitlements.js';
import { allowanceRefusal, manualRunRefusal } from './start-run.js';
import { FREE_APPLICATIONS, PAID_PLANS, PLAN_LIMITS } from '../src/pricing.js';

/**
 * Account states an admin can preview.
 *
 * An admin has no limits, so nothing on their own dashboard ever shows what a
 * customer who has run out sees. Each scenario here is a set of invented facts
 * — which pass, how much of it is left, how many scheduled runs were used today — and
 * everything shown for it comes from the same code a real account goes
 * through: `deriveEntitlements` for what the account may do, and the run-start
 * refusals for what pressing the button would answer. Nothing is stored and no
 * account is touched; the browser swaps these in for its own status while the
 * preview is on (src/simulation.ts).
 */

interface Scenario {
  key: string;
  group: 'Free plan' | 'Essential Pass' | 'Active Search' | 'Intensive Pass';
  label: string;
  description: string;
  pass: 'none' | 'essential-pass' | 'job-search-pass' | 'intensive-pass';
  /** Applications left on the pass. A pass with none left is no longer an active pass. */
  paidRemaining: number;
  freeRemaining: number;
  autoRunsUsedToday?: number;
  autoApplyPaused?: boolean;
  hasSuccessfulRun?: boolean;
}

const ESSENTIAL = PAID_PLANS['essential-pass'].applications;
const JOB_SEARCH = PAID_PLANS['job-search-pass'].applications;
const INTENSIVE = PAID_PLANS['intensive-pass'].applications;

const SCENARIOS: Scenario[] = [
  { key: 'free-new', group: 'Free plan', label: 'New account', description: `Just signed up: all ${FREE_APPLICATIONS} free applications left.`, pass: 'none', paidRemaining: 0, freeRemaining: FREE_APPLICATIONS, hasSuccessfulRun: false },
  { key: 'free-out', group: 'Free plan', label: 'Out of applications', description: 'The free applications are used up and no pass was bought. Scheduled runs are refused.', pass: 'none', paidRemaining: 0, freeRemaining: 0 },
  { key: 'essential-active', group: 'Essential Pass', label: 'Active', description: `Affordable SEEK automation, ${PLAN_LIMITS['essential-pass'].autoRunsPerDay} run a day.`, pass: 'essential-pass', paidRemaining: Math.round(ESSENTIAL * 0.6), freeRemaining: 0 },
  { key: 'job-search-active', group: 'Active Search', label: 'Active', description: `Part-way through the pass, ${PLAN_LIMITS['job-search-pass'].autoRunsPerDay} automatic runs a day.`, pass: 'job-search-pass', paidRemaining: Math.round(JOB_SEARCH * 0.6), freeRemaining: 0, autoRunsUsedToday: 1 },
  { key: 'job-search-last', group: 'Active Search', label: 'Last few applications', description: 'Three applications left: the next run is capped at three.', pass: 'job-search-pass', paidRemaining: 3, freeRemaining: 0, autoRunsUsedToday: 2 },
  { key: 'job-search-paused', group: 'Active Search', label: 'Auto apply switched off', description: 'The customer paused their automatic runs.', pass: 'job-search-pass', paidRemaining: Math.round(JOB_SEARCH * 0.6), freeRemaining: 0, autoApplyPaused: true },
  { key: 'pass-used-up', group: 'Active Search', label: 'Pass used up', description: 'Every application on the pass is spent. The account falls back to the free plan with nothing left.', pass: 'job-search-pass', paidRemaining: 0, freeRemaining: 0 },
  { key: 'intensive-active', group: 'Intensive Pass', label: 'Active', description: `${PLAN_LIMITS['intensive-pass'].autoRunsPerDay} automatic runs a day with advanced controls.`, pass: 'intensive-pass', paidRemaining: Math.round(INTENSIVE * 0.6), freeRemaining: 0 },
  { key: 'intensive-last', group: 'Intensive Pass', label: 'Last application', description: 'One application remains; the next scheduled run stops after it is submitted.', pass: 'intensive-pass', paidRemaining: 1, freeRemaining: 0, autoRunsUsedToday: 1 },
];

/** What the server would answer to a run start. `null` means it would start. */
type Verdict = { status: number; error: string } | null;

interface Simulation {
  key: string;
  group: Scenario['group'];
  label: string;
  description: string;
  billing: BillingStatus;
  entitlements: Entitlements;
  /** Pressing Start auto apply. */
  manualStart: Verdict;
  /** The scheduler's next automatic run. */
  scheduledStart: Verdict;
}

function simulate(scenario: Scenario): Simulation {
  const active = scenario.pass !== 'none' && scenario.paidRemaining > 0;
  const billing: BillingStatus = {
    configured: paymentsConfigured(),
    free: { allowance: FREE_APPLICATIONS, used: FREE_APPLICATIONS - scenario.freeRemaining, remaining: scenario.freeRemaining },
    paid: {
      remaining: scenario.paidRemaining,
      employerSiteRemaining: active && scenario.pass === 'intensive-pass' ? 18 : 0,
      expiresAt: active ? new Date(Date.now() + 21 * 86_400_000).toISOString() : null,
      hasActivePass: active,
      hasActiveEssentialPass: active && scenario.pass === 'essential-pass',
      hasActiveJobSearchPass: active && scenario.pass === 'job-search-pass',
      hasActiveIntensivePass: active && scenario.pass === 'intensive-pass',
    },
    totalRemaining: scenario.paidRemaining + scenario.freeRemaining,
  };
  const entitlements = deriveEntitlements({
    admin: false,
    billing,
    autoRunsUsedToday: scenario.autoRunsUsedToday ?? 0,
    autoApplyPaused: scenario.autoApplyPaused ?? false,
    hasSuccessfulRun: scenario.hasSuccessfulRun ?? true,
    overrides: { evaluationsPerRun: null, maxApplicationsPerRun: null, humanizer: null },
    // A pass includes unlimited suggestions; the free plan's single one is shown as still available.
    searchTermSuggestionsLeft: active ? null : FREE_SEARCH_TERM_SUGGESTIONS,
  });
  const strip = (refusal: { status: number; error: string } | null): Verdict => refusal && { status: refusal.status, error: refusal.error };
  const allowance = strip(allowanceRefusal(billing));
  return {
    key: scenario.key,
    group: scenario.group,
    label: scenario.label,
    description: scenario.description,
    billing,
    entitlements,
    manualStart: strip(manualRunRefusal(entitlements)) ?? allowance,
    scheduledStart: entitlements.firstRunRequired
      ? { status: 0, error: 'Waiting for the customer to complete their first run.' }
      : entitlements.autoRunsPerDay < 1
        ? { status: 0, error: 'This plan has no automatic runs.' }
      : entitlements.autoApplyPaused
        ? { status: 0, error: 'Automatic runs are switched off, so none is scheduled.' }
        : allowance,
  };
}

export const simulations = (): Simulation[] => SCENARIOS.map(simulate);
