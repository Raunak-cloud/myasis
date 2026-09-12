import { applyRunPolicy, automaticRunsPerDay, SCHEDULED_MIN_SCORE } from './entitlements.js';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

const saved = {
  KEYWORDS: 'medical receptionist',
  TARGET_ROLE: 'legacy hidden role',
  ONSITE_CITY: 'Sydney',
  MIN_SCORE: '22',
  MAX_EVALUATIONS: '150',
  COVER_LETTER_MODE: 'reuse',
};

const standardManual = applyRunPolicy(saved, { fineTune: false }, 'manual');
check('standard accounts keep their job preferences', standardManual.KEYWORDS === saved.KEYWORDS);
check('standard accounts keep their location preference', standardManual.ONSITE_CITY === saved.ONSITE_CITY);
check('removed target roles cannot influence standard runs', standardManual.TARGET_ROLE === '');
check('standard accounts cannot retain a custom match threshold', standardManual.MIN_SCORE !== saved.MIN_SCORE);
check('standard accounts cannot retain custom evaluation limits', standardManual.MAX_EVALUATIONS !== saved.MAX_EVALUATIONS);
check('standard accounts cannot retain custom cover-letter behavior', standardManual.COVER_LETTER_MODE !== saved.COVER_LETTER_MODE);

const scheduled = applyRunPolicy(saved, { fineTune: false }, 'auto');
check('scheduled applications always require a 75 percent match', scheduled.MIN_SCORE === String(SCHEDULED_MIN_SCORE));

const intensive = applyRunPolicy({ ...saved, MIN_SCORE: '70' }, { fineTune: true }, 'manual');
check('Intensive accounts keep their fine tuning', intensive.MIN_SCORE === '70');
check('removed target roles cannot influence Intensive runs', intensive.TARGET_ROLE === '');

const admin = applyRunPolicy({ ...saved, MAX_EVALUATIONS: '500' }, { fineTune: true }, 'manual');
check('admins keep their fine tuning', admin.MAX_EVALUATIONS === '500');
check('admins receive four scheduled runs', automaticRunsPerDay('admin') === 4);
check('Intensive remains manual only', automaticRunsPerDay('intensive') === 0);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
