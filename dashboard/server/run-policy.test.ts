import { applyRunPolicy, automaticRunsPerDay, deriveEntitlements, effectivePlatforms, PLATFORMS_CHOSEN_KEY, SCHEDULED_MIN_SCORE } from './entitlements.js';
import { manualRunRefusal, runControlRefusal } from './start-run.js';
import { PLAN_LIMITS, PLAN_PRESENTATION } from '../src/pricing.js';
import { matchThresholdError } from '../src/runSettings.js';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

const saved = {
  KEYWORDS: 'medical receptionist',
  EXCLUDED_COMPANIES: 'Acme, Example Bank',
  PLATFORMS: 'seek',
  TARGET_ROLE: 'legacy hidden role',
  ONSITE_CITY: 'Sydney',
  MIN_SCORE: '22',
  MAX_AGE_DAYS: '3',
  MAX_EVALUATIONS: '150',
  COVER_LETTER_MODE: 'reuse',
  AI_INSTRUCTIONS_B64: 'ZG9udCBhcHBseSBmb3Igc2VuaW9yIHJvbGVz',
};

const freePolicy = { tier: 'standard' as const, fineTune: false, advancedFilters: false, indeedApplications: false, evaluationsPerRun: PLAN_LIMITS.free.evaluationsPerRun, maxApplicationsPerRunOverride: null };
const essentialPolicy = { tier: 'standard' as const, fineTune: false, advancedFilters: false, indeedApplications: false, evaluationsPerRun: PLAN_LIMITS['essential-pass'].evaluationsPerRun, maxApplicationsPerRunOverride: null };
const jobSearchPolicy = { tier: 'standard' as const, fineTune: false, advancedFilters: true, indeedApplications: true, evaluationsPerRun: PLAN_LIMITS['job-search-pass'].evaluationsPerRun, maxApplicationsPerRunOverride: null };
const intensivePolicy = { tier: 'intensive' as const, fineTune: true, advancedFilters: true, indeedApplications: true, evaluationsPerRun: PLAN_LIMITS['intensive-pass'].evaluationsPerRun, maxApplicationsPerRunOverride: null };
const adminPolicy = { tier: 'admin' as const, fineTune: true, advancedFilters: true, indeedApplications: true, evaluationsPerRun: null, maxApplicationsPerRunOverride: null };

for (const policy of [freePolicy, essentialPolicy, jobSearchPolicy, intensivePolicy, adminPolicy]) {
  for (const trigger of ['manual', 'auto'] as const) {
    check(`${policy.tier} ${trigger} overrides cannot exceed three search titles`,
      applyRunPolicy({ ...saved, KEYWORDS: 'AI Engineer, Web Developer, Python Developer, Frontend Developer' }, policy, trigger).KEYWORDS
      === 'AI Engineer, Web Developer, Python Developer');
  }
}

const standardManual = applyRunPolicy(saved, freePolicy, 'manual');
check('standard accounts keep their job preferences', standardManual.KEYWORDS === saved.KEYWORDS);
check('standard accounts keep their excluded companies', standardManual.EXCLUDED_COMPANIES === saved.EXCLUDED_COMPANIES);
check('standard accounts keep their location preference', standardManual.ONSITE_CITY === saved.ONSITE_CITY);
check('removed target roles cannot influence standard runs', standardManual.TARGET_ROLE === '');
check('standard accounts cannot retain a custom match threshold', standardManual.MIN_SCORE !== saved.MIN_SCORE);
check('standard accounts cannot retain custom evaluation limits', standardManual.MAX_EVALUATIONS !== saved.MAX_EVALUATIONS);
check('standard accounts cannot retain custom cover-letter behavior', standardManual.COVER_LETTER_MODE !== saved.COVER_LETTER_MODE);
check('standard accounts cannot retain fine-tuning prompts', standardManual.AI_INSTRUCTIONS_B64 === '');

const scheduled = applyRunPolicy(saved, freePolicy, 'auto');
check('Free and Essential scheduled applications require a 75 percent match', scheduled.MIN_SCORE === String(SCHEDULED_MIN_SCORE) && applyRunPolicy(saved, essentialPolicy, 'auto').MIN_SCORE === '75');
for (const policy of [jobSearchPolicy, intensivePolicy]) for (const trigger of ['manual', 'auto'] as const) {
  for (const score of ['60', '70', '75', '100']) {
    check(`${policy.tier} ${trigger} honours a ${score}% match threshold`, applyRunPolicy({ ...saved, MIN_SCORE: score }, policy, trigger).MIN_SCORE === score);
  }
  for (const [score, expected] of [['22', '60'], ['101', '100'], ['invalid', '75']]) {
    check(`${policy.tier} ${trigger} bounds a legacy ${score} threshold`, applyRunPolicy({ ...saved, MIN_SCORE: score }, policy, trigger).MIN_SCORE === expected);
  }
}
for (const value of ['59', '101', '', 'NaN', 'Infinity', '-1']) check(`an invalid ${JSON.stringify(value)} match threshold is rejected`, matchThresholdError(value) !== null);
for (const value of ['60', '70', '100']) check(`a ${value}% match threshold is valid`, matchThresholdError(value) === null);
check('standard scheduled runs cannot inherit fine-tuning prompts', scheduled.AI_INSTRUCTIONS_B64 === '');

const intensive = applyRunPolicy({ ...saved, MIN_SCORE: '70' }, intensivePolicy, 'manual');
check('Intensive accounts keep their fine tuning', intensive.MIN_SCORE === '70');
check('Intensive live runs keep the saved prompt', intensive.AI_INSTRUCTIONS_B64 === saved.AI_INSTRUCTIONS_B64);
check('removed target roles cannot influence Intensive runs', intensive.TARGET_ROLE === '');
check('Intensive runs assess 80 jobs', intensive.MAX_EVALUATIONS === '80');

const admin = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '500' }, adminPolicy, 'manual');
check('admins keep a review limit they set, unclamped', admin.MAX_EVALUATIONS === '500');
check('admins have the global daily ceiling even when per-run applications are unlimited', admin.MAX_APPS_PER_RUN === 'none' && admin.MAX_APPS_PER_DAY === '100');
const adminBlank = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '', MAX_APPS_PER_RUN: '0', MAX_APPS_PER_DAY: ' ' }, adminPolicy, 'manual');
check('empty optional admin limits mean none; the daily ceiling stays 100', adminBlank.MAX_EVALUATIONS === 'none' && adminBlank.MAX_APPS_PER_RUN === 'none' && adminBlank.MAX_APPS_PER_DAY === '100');
const adminTyped = applyRunPolicy({ ...saved, MAX_APPS_PER_RUN: '30', MAX_APPS_PER_DAY: '80' }, adminPolicy, 'manual');
check('admins keep application limits they set, above the plan ceilings', adminTyped.MAX_APPS_PER_RUN === '30' && adminTyped.MAX_APPS_PER_DAY === '80');
for (const policy of [intensivePolicy, adminPolicy]) {
  const high = applyRunPolicy({ ...saved, MAX_AGE_DAYS:'99', MAX_APPS_PER_DAY:'999', PAGES_PER_KEYWORD:'99' }, policy, 'auto');
  check(`${policy.tier} legacy settings obey the 30-day, 100-application and six-page maximums`, high.MAX_AGE_DAYS === '30' && high.MAX_APPS_PER_DAY === '100' && high.PAGES_PER_KEYWORD === '6');
  const boundary = applyRunPolicy({ ...saved, MAX_AGE_DAYS:'30', MAX_APPS_PER_DAY:'100', PAGES_PER_KEYWORD:'6' }, policy, 'auto');
  check(`${policy.tier} can use all three upper boundaries`, boundary.MAX_AGE_DAYS === '30' && boundary.MAX_APPS_PER_DAY === '100' && boundary.PAGES_PER_KEYWORD === '6');
}
check('Active Search listing-age settings also stop at 30 days', applyRunPolicy({ ...saved, MAX_AGE_DAYS:'99' }, jobSearchPolicy, 'auto').MAX_AGE_DAYS === '30');

const standardAuto = applyRunPolicy(saved, freePolicy, 'auto');
check('Free runs assess 15 jobs', standardAuto.MAX_EVALUATIONS === '15');
check('Free first-run policy also assesses 15 jobs', standardManual.MAX_EVALUATIONS === '15');
check('Essential runs assess 25 jobs', applyRunPolicy(saved, essentialPolicy, 'auto').MAX_EVALUATIONS === '25');
const adminAuto = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '100' }, adminPolicy, 'auto');
check('admin scheduled runs keep their review limit and the global daily ceiling', adminAuto.MAX_EVALUATIONS === '100' && adminAuto.MAX_APPS_PER_DAY === '100');
check('admin scheduled runs keep their own match threshold', adminAuto.MIN_SCORE === saved.MIN_SCORE);
check('admin scheduled live runs keep the saved prompt', adminAuto.AI_INSTRUCTIONS_B64 === saved.AI_INSTRUCTIONS_B64);
const jobSearchAuto = applyRunPolicy(saved, jobSearchPolicy, 'auto');
const activeFiltered = applyRunPolicy({ ...saved, MIN_SCORE: '88' }, jobSearchPolicy, 'auto');
check('Free runs stay on SEEK', scheduled.PLATFORMS === 'seek');
check('Active Search runs use SEEK and Indeed', jobSearchAuto.PLATFORMS === 'seek,indeed');
check('Active Search runs assess 70 jobs', jobSearchAuto.MAX_EVALUATIONS === '70');
check('Active Search keeps its advanced listing-age filter', jobSearchAuto.MAX_AGE_DAYS === '3');
check('Active Search can raise its scheduled match threshold', activeFiltered.MIN_SCORE === '88');
check('Active Search still cannot save Intensive standing instructions', jobSearchAuto.AI_INSTRUCTIONS_B64 === '');
check('free accounts receive one scheduled run', automaticRunsPerDay('standard') === 1);
check('Essential accounts receive two scheduled runs', automaticRunsPerDay('standard', 'essential') === 2);
check('Active Search accounts receive four scheduled runs', automaticRunsPerDay('standard', 'active') === 4);
check('admins receive four scheduled runs', automaticRunsPerDay('admin') === 4);
check('Intensive includes four automatic runs', automaticRunsPerDay('intensive') === 4);

const intensiveFacts = {
  admin: false,
  billing: { paid: {
    remaining: 100,
    employerSiteRemaining: 20,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    hasActivePass: true,
    hasActiveEssentialPass: false,
    hasActiveJobSearchPass: false,
    hasActiveIntensivePass: true,
  } },
  autoRunsUsedToday: 0,
  autoApplyPaused: false,
  hasSuccessfulRun: true,
  overrides: { evaluationsPerRun: null, maxApplicationsPerRun: null },
  searchTermSuggestionsLeft: null,
};
const intensiveEntitlements = deriveEntitlements(intensiveFacts);
const adminEntitlements = deriveEntitlements({ ...intensiveFacts, admin: true });
const freeEntitlements = deriveEntitlements({ ...intensiveFacts, hasSuccessfulRun: false,
  billing: { paid: { ...intensiveFacts.billing.paid, remaining: 0, employerSiteRemaining: 0, expiresAt: null,
    hasActivePass: false, hasActiveEssentialPass: false, hasActiveJobSearchPass: false, hasActiveIntensivePass: false } },
});
check('new free accounts receive 15 reviews per run and up to 15 per day', freeEntitlements.evaluationsPerRun === 15 && freeEntitlements.scheduledJobsPerDay === 15);
check('a failed empty free onboarding run remains retryable', freeEntitlements.firstRunRequired && manualRunRefusal(freeEntitlements) === null);
check('free accounts receive one daily run and SEEK-only access', freeEntitlements.autoRunsPerDay === 1 && !freeEntitlements.indeedApplications);
const essentialEntitlements = deriveEntitlements({ ...intensiveFacts,
  billing: { paid: { ...intensiveFacts.billing.paid, hasActiveIntensivePass: false, hasActiveEssentialPass: true } },
});
const activeEntitlements = deriveEntitlements({ ...intensiveFacts,
  billing: { paid: { ...intensiveFacts.billing.paid, hasActiveIntensivePass: false, hasActiveJobSearchPass: true } },
});
check('editable plans expose a 60% minimum', activeEntitlements.scheduledMinScore === 60 && intensiveEntitlements.scheduledMinScore === 60);
check('Free and Essential keep the 75% minimum', freeEntitlements.scheduledMinScore === 75 && essentialEntitlements.scheduledMinScore === 75);
check('Essential allows two runs and 50 reviews per day', essentialEntitlements.autoRunsPerDay === 2 && essentialEntitlements.scheduledJobsPerDay === 50);
for (const plan of [freeEntitlements, essentialEntitlements, intensiveEntitlements]) {
  check(`${plan.autoRunsPerDay}-run customers cannot bypass scheduled spacing with a direct manual start`, runControlRefusal('manual', plan)?.status === 403);
  check(`${plan.autoRunsPerDay}-run customers can confirm prepared applications after their run allowance is used`, runControlRefusal('manual', { ...plan, autoRunsUsedToday: plan.autoRunsPerDay }, true) === null);
}
check('customers start their runs manually', intensiveEntitlements.manualRuns);
check('administrators can start runs manually', adminEntitlements.manualRuns);
const newCustomerEntitlements = deriveEntitlements({ ...intensiveFacts, hasSuccessfulRun: false });
check('a new customer must start the first run', newCustomerEntitlements.firstRunRequired);
check('a completed setup or first run never enables scheduling', deriveEntitlements({ ...intensiveFacts, autoApplyPaused: true }).autoApplyPaused && intensiveEntitlements.canPauseAutoApply);
check('a new customer is allowed to start that first run', manualRunRefusal(newCustomerEntitlements) === null);
check('customers can start later runs within their daily allowance', manualRunRefusal(intensiveEntitlements) === null);
check('scheduler authorization is checked against the durable schedule at actual start', runControlRefusal('auto', intensiveEntitlements) === null);
check('manual discovery cannot bypass the saved schedule', runControlRefusal('manual', intensiveEntitlements)?.status === 403);
check('manual starts cannot exceed the plan daily run allowance', runControlRefusal('manual', { ...freeEntitlements, autoRunsUsedToday: 1 })?.status === 403);
check('confirming prepared jobs does not spend another daily run', runControlRefusal('manual', { ...freeEntitlements, autoRunsUsedToday: 1 }, true) === null);

// An operator's per-account override is a control, not a suggestion: it wins
// over the free plan's own default and survives the fine-tuning reset that
// wipes anything else a standard account tries to save for this key.
const freeWithOverride = { ...freePolicy, maxApplicationsPerRunOverride: 2 };
const overridden = applyRunPolicy(saved, freeWithOverride, 'manual');
check('an operator override wins over the free plan default', overridden.MAX_APPS_PER_RUN === '2');
const intensiveWithOverride = { ...intensivePolicy, maxApplicationsPerRunOverride: 1 };
const overriddenIntensive = applyRunPolicy({ ...saved, MAX_APPS_PER_RUN: '10' }, intensiveWithOverride, 'manual');
check('an operator override wins over an Intensive account\'s own saved value', overriddenIntensive.MAX_APPS_PER_RUN === '1');
// An override on an operator's own account binds it too. Discarding it let an
// account whose Limits panel read 51 review every listing it found.
const adminWithOverride = applyRunPolicy(saved, { ...adminPolicy, maxApplicationsPerRunOverride: 3 }, 'manual');
check('an operator override binds an admin account as well', adminWithOverride.MAX_APPS_PER_RUN === '3');
const adminReviewOverride = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '' }, { ...adminPolicy, evaluationsPerRun: 50 }, 'manual');
check('a review override caps an admin account that set no limit of its own', adminReviewOverride.MAX_EVALUATIONS === '50');
const adminOverrideWins = applyRunPolicy(
  { ...saved, MAX_EVALUATIONS: '500', MAX_APPS_PER_RUN: '30' },
  { ...adminPolicy, evaluationsPerRun: 50, maxApplicationsPerRunOverride: 3 },
  'manual',
);
check('an override wins over the numbers an admin saved itself', adminOverrideWins.MAX_EVALUATIONS === '50' && adminOverrideWins.MAX_APPS_PER_RUN === '3');
const adminNoOverride = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '' }, adminPolicy, 'manual');
check('an admin with no override still has no limit', adminNoOverride.MAX_EVALUATIONS === 'none' && adminNoOverride.MAX_APPS_PER_RUN === 'none');
const adminOverrideAuto = applyRunPolicy(saved, { ...adminPolicy, evaluationsPerRun: 50 }, 'auto');
check('a review override holds for an admin\'s scheduled runs too', adminOverrideAuto.MAX_EVALUATIONS === '50');

// What a manual run posts goes through the plan, not around it.
const posted = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '40', PLATFORMS: 'seek' }, intensivePolicy, 'manual');
check('a posted evaluation count cannot lower or raise the Intensive plan', posted.MAX_EVALUATIONS === '80');
check('a posted default board list still includes the Indeed an Intensive Pass pays for', posted.PLATFORMS === 'seek,indeed');

// A board list the account picked is used exactly as picked (Rinu Thapa unticked Indeed and got it anyway, 5 Oct).
const chosenSeek = applyRunPolicy({ ...saved, PLATFORMS: 'seek' }, jobSearchPolicy, 'manual', true);
check('SEEK alone, picked by the account, stays SEEK alone on a pass that includes Indeed', chosenSeek.PLATFORMS === 'seek');
check('Indeed alone, picked by the account, stays Indeed alone', applyRunPolicy({ ...saved, PLATFORMS: 'indeed' }, intensivePolicy, 'manual', true).PLATFORMS === 'indeed');
check('the plan default still adds Indeed when nothing was picked', effectivePlatforms({ PLATFORMS: 'seek' }, jobSearchPolicy) === 'seek,indeed');
check('nothing saved at all: the plan default', effectivePlatforms({}, jobSearchPolicy) === 'seek,indeed' && effectivePlatforms({}, freePolicy) === 'seek');
check('a picked SEEK-only list is reported as SEEK only', effectivePlatforms({ PLATFORMS: 'seek', [PLATFORMS_CHOSEN_KEY]: '1' }, intensivePolicy) === 'seek');
check('a free account is never given Indeed', effectivePlatforms({ PLATFORMS: 'seek' }, freePolicy) === 'seek');

// Every number a plan advertises is the number the server enforces.
const said = (plan: keyof typeof PLAN_PRESENTATION) => PLAN_PRESENTATION[plan].features.join(' | ');
check('Active Search and Get Owtomated advertise the editable 60-100% range', ['job-search-pass', 'intensive-pass'].every(plan => said(plan as keyof typeof PLAN_PRESENTATION).includes('Choose your minimum match score: 60% to 100%')));
check('Free says the scheduled run and reviews it gets', said('free').includes('1 scheduled run each day') && said('free').includes(`up to ${PLAN_LIMITS.free.evaluationsPerRun} jobs`));
check('Essential says it gets two scheduled runs', said('essential-pass').includes('2 scheduled runs each day'));
check('Active Search says the scheduled runs and reviews it gets', said('job-search-pass').includes(`Up to ${automaticRunsPerDay('standard', 'active')} scheduled runs`) && said('job-search-pass').includes(`up to ${PLAN_LIMITS['job-search-pass'].evaluationsPerRun} jobs`));
check('Intensive says scheduled runs, both modes, reviews and employer-site applications', said('intensive-pass').includes('Up to 4 scheduled runs') && said('intensive-pass').includes('Semi auto') && said('intensive-pass').includes('up to 80 jobs') && said('intensive-pass').includes('employer-site applications'));
check('no plan says each month', !Object.values(PLAN_PRESENTATION).some((plan) => plan.features.some((feature) => /each month|a month|monthly/i.test(feature))));

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
