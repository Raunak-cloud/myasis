import { applyRunPolicy, automaticRunsPerDay, deriveEntitlements, SCHEDULED_MIN_SCORE } from './entitlements.js';
import { PLAN_LIMITS, PLAN_PRESENTATION } from '../src/pricing.js';

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

const freePolicy = { tier: 'standard' as const, fineTune: false, advancedFilters: false, indeedApplications: false, evaluationsPerRun: PLAN_LIMITS.free.evaluationsPerRun, humanizer: false, maxApplicationsPerRunOverride: null };
const essentialPolicy = { tier: 'standard' as const, fineTune: false, advancedFilters: false, indeedApplications: false, evaluationsPerRun: PLAN_LIMITS['essential-pass'].evaluationsPerRun, humanizer: false, maxApplicationsPerRunOverride: null };
const jobSearchPolicy = { tier: 'standard' as const, fineTune: false, advancedFilters: true, indeedApplications: true, evaluationsPerRun: PLAN_LIMITS['job-search-pass'].evaluationsPerRun, humanizer: true, maxApplicationsPerRunOverride: null };
const intensivePolicy = { tier: 'intensive' as const, fineTune: true, advancedFilters: true, indeedApplications: true, evaluationsPerRun: PLAN_LIMITS['intensive-pass'].evaluationsPerRun, humanizer: true, maxApplicationsPerRunOverride: null };
const adminPolicy = { tier: 'admin' as const, fineTune: true, advancedFilters: true, indeedApplications: true, evaluationsPerRun: null, humanizer: true, maxApplicationsPerRunOverride: null };

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
check('scheduled applications always require a 75 percent match', scheduled.MIN_SCORE === String(SCHEDULED_MIN_SCORE));
check('standard scheduled runs cannot inherit fine-tuning prompts', scheduled.AI_INSTRUCTIONS_B64 === '');

const intensive = applyRunPolicy({ ...saved, MIN_SCORE: '70' }, intensivePolicy, 'manual');
check('Intensive accounts keep their fine tuning', intensive.MIN_SCORE === '70');
check('Intensive live runs keep the saved prompt', intensive.AI_INSTRUCTIONS_B64 === saved.AI_INSTRUCTIONS_B64);
check('removed target roles cannot influence Intensive runs', intensive.TARGET_ROLE === '');
check('Intensive runs assess 100 jobs', intensive.MAX_EVALUATIONS === '100');

const admin = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '500' }, adminPolicy, 'manual');
check('admins keep a review limit they set, unclamped', admin.MAX_EVALUATIONS === '500');
check('admins with no saved limit have none on applications per run or per day', admin.MAX_APPS_PER_RUN === 'none' && admin.MAX_APPS_PER_DAY === 'none');
const adminBlank = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '', MAX_APPS_PER_RUN: '0', MAX_APPS_PER_DAY: ' ' }, adminPolicy, 'manual');
check('an empty, zero or blank admin limit means none', adminBlank.MAX_EVALUATIONS === 'none' && adminBlank.MAX_APPS_PER_RUN === 'none' && adminBlank.MAX_APPS_PER_DAY === 'none');
const adminTyped = applyRunPolicy({ ...saved, MAX_APPS_PER_RUN: '30', MAX_APPS_PER_DAY: '80' }, adminPolicy, 'manual');
check('admins keep application limits they set, above the plan ceilings', adminTyped.MAX_APPS_PER_RUN === '30' && adminTyped.MAX_APPS_PER_DAY === '80');

const standardAuto = applyRunPolicy(saved, freePolicy, 'auto');
check('Free runs assess 5 jobs', standardAuto.MAX_EVALUATIONS === '5');
check('Essential runs assess 25 jobs', applyRunPolicy(saved, essentialPolicy, 'auto').MAX_EVALUATIONS === '25');
const adminAuto = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '100' }, adminPolicy, 'auto');
check('admin scheduled runs keep their own limits too', adminAuto.MAX_EVALUATIONS === '100' && adminAuto.MAX_APPS_PER_DAY === 'none');
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
check('Free runs never use the humanizer', scheduled.HUMANIZER_MODE === 'off' && standardManual.HUMANIZER_MODE === 'off');
check('Active Search runs keep the humanizer', jobSearchAuto.HUMANIZER_MODE !== 'off');
check('Intensive runs keep the humanizer', intensive.HUMANIZER_MODE !== 'off');
check('free accounts receive one scheduled run', automaticRunsPerDay('standard') === 1);
check('Essential accounts receive one scheduled run', automaticRunsPerDay('standard', 'essential') === 1);
check('Active Search accounts receive four scheduled runs', automaticRunsPerDay('standard', 'active') === 4);
check('admins receive ten scheduled runs', automaticRunsPerDay('admin') === 10);
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
  overrides: { evaluationsPerRun: null, maxApplicationsPerRun: null },
  searchTermSuggestionsLeft: null,
};
const intensiveEntitlements = deriveEntitlements(intensiveFacts);
const adminEntitlements = deriveEntitlements({ ...intensiveFacts, admin: true });
check('customers cannot start runs manually', !intensiveEntitlements.manualRuns);
check('administrators can start runs manually', adminEntitlements.manualRuns);

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
check('a posted evaluation count cannot lower or raise the Intensive plan', posted.MAX_EVALUATIONS === '100');
check('a posted default board list still includes the Indeed an Intensive Pass pays for', posted.PLATFORMS === 'seek,indeed');

// Every number a plan advertises is the number the server enforces.
const said = (plan: keyof typeof PLAN_PRESENTATION) => PLAN_PRESENTATION[plan].features.join(' | ');
check('Free says the runs and reviews it gets', said('free').includes(`${automaticRunsPerDay('standard')} automatic live run each day`) && said('free').includes(`up to ${PLAN_LIMITS.free.evaluationsPerRun} jobs`));
check('Active Search says the runs and reviews it gets', said('job-search-pass').includes(`Up to ${automaticRunsPerDay('standard', 'active')} automatic live runs`) && said('job-search-pass').includes(`up to ${PLAN_LIMITS['job-search-pass'].evaluationsPerRun} jobs`));
check('Intensive says the automatic runs, reviews and employer sites it gets', said('intensive-pass').includes('Up to 4 automatic live runs') && !/user-started|manual run/i.test(said('intensive-pass')) && said('intensive-pass').includes('up to 100 jobs') && said('intensive-pass').includes('30 employer-site applications'));
check('no plan says each month', !Object.values(PLAN_PRESENTATION).some((plan) => plan.features.some((feature) => /each month|a month|monthly/i.test(feature))));

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
