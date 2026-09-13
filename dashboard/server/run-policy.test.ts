import { applyRunPolicy, automaticRunsPerDay, SCHEDULED_MIN_SCORE } from './entitlements.js';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

const saved = {
  KEYWORDS: 'medical receptionist',
  PLATFORMS: 'seek',
  TARGET_ROLE: 'legacy hidden role',
  ONSITE_CITY: 'Sydney',
  MIN_SCORE: '22',
  MAX_EVALUATIONS: '150',
  COVER_LETTER_MODE: 'reuse',
  AI_INSTRUCTIONS_B64: 'ZG9udCBhcHBseSBmb3Igc2VuaW9yIHJvbGVz',
};

const standardManual = applyRunPolicy(saved, { fineTune: false, indeedApplications: false }, 'manual');
check('standard accounts keep their job preferences', standardManual.KEYWORDS === saved.KEYWORDS);
check('standard accounts keep their location preference', standardManual.ONSITE_CITY === saved.ONSITE_CITY);
check('removed target roles cannot influence standard runs', standardManual.TARGET_ROLE === '');
check('standard accounts cannot retain a custom match threshold', standardManual.MIN_SCORE !== saved.MIN_SCORE);
check('standard accounts cannot retain custom evaluation limits', standardManual.MAX_EVALUATIONS !== saved.MAX_EVALUATIONS);
check('standard accounts cannot retain custom cover-letter behavior', standardManual.COVER_LETTER_MODE !== saved.COVER_LETTER_MODE);
check('standard accounts cannot retain fine-tuning prompts', standardManual.AI_INSTRUCTIONS_B64 === '');

const scheduled = applyRunPolicy(saved, { fineTune: false, indeedApplications: false }, 'auto');
check('scheduled applications always require a 75 percent match', scheduled.MIN_SCORE === String(SCHEDULED_MIN_SCORE));
check('standard scheduled runs cannot inherit fine-tuning prompts', scheduled.AI_INSTRUCTIONS_B64 === '');

const intensive = applyRunPolicy({ ...saved, MIN_SCORE: '70' }, { fineTune: true, indeedApplications: true }, 'manual');
check('Intensive accounts keep their fine tuning', intensive.MIN_SCORE === '70');
check('Intensive live runs keep the saved prompt', intensive.AI_INSTRUCTIONS_B64 === saved.AI_INSTRUCTIONS_B64);
check('removed target roles cannot influence Intensive runs', intensive.TARGET_ROLE === '');

const admin = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '500' }, { fineTune: true, indeedApplications: true }, 'manual');
check('admins keep their fine tuning', admin.MAX_EVALUATIONS === '500');

const standardAuto = applyRunPolicy(saved, { fineTune: false, indeedApplications: false }, 'auto');
check('a scheduled run assesses a full day\'s share of listings', standardAuto.MAX_EVALUATIONS === '60');
const adminAuto = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '100' }, { fineTune: true, indeedApplications: true }, 'auto');
check('a higher saved ceiling is kept on a scheduled run', adminAuto.MAX_EVALUATIONS === '100');
check('admin scheduled live runs keep the saved prompt', adminAuto.AI_INSTRUCTIONS_B64 === saved.AI_INSTRUCTIONS_B64);
const jobSearchAuto = applyRunPolicy(saved, { fineTune: false, indeedApplications: true }, 'auto');
check('Free runs stay on SEEK', scheduled.PLATFORMS === 'seek');
check('Job Search Pass runs use SEEK and Indeed', jobSearchAuto.PLATFORMS === 'seek,indeed');
check('free accounts receive one scheduled run', automaticRunsPerDay('standard') === 1);
check('Job Search Pass accounts receive four scheduled runs', automaticRunsPerDay('standard', true) === 4);
check('admins receive four scheduled runs', automaticRunsPerDay('admin') === 4);
check('Intensive remains manual only', automaticRunsPerDay('intensive') === 0);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
