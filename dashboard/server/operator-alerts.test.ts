import { operatorAlertsFor, type OperatorFacts } from './operator-alerts.js';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

const calm: OperatorFacts = {
  attempted: 12, applied: 7, humanizedLetters: 6, draftLetters: 1, unconfirmedSubmits: 0,
  providersOutOfCredit: [], failedRunsInARow: 0, duplicateApplications: [], capMonsterBalance: 4.7,
};
const keys = (facts: Partial<OperatorFacts>) => operatorAlertsFor({ ...calm, ...facts }).map((alert) => alert.key);

check('a healthy day raises nothing', keys({}).length === 0);
check('a provider out of credit alerts at once', keys({ providersOutOfCredit: ['Celeris'] }).includes('provider-out-of-credit')
  && operatorAlertsFor({ ...calm, providersOutOfCredit: ['Celeris'] })[0].holdMinutes === 0);
check('a low CapMonster balance alerts; an unknown one does not', keys({ capMonsterBalance: 1.5 }).includes('capmonster-low') && !keys({ capMonsterBalance: null }).includes('capmonster-low'));
check('a low success rate over enough attempts alerts', keys({ attempted: 20, applied: 3 }).includes('low-success-rate'));
check('a bad rate over too few attempts is noise', !keys({ attempted: 4, applied: 0 }).includes('low-success-rate'));
check('mostly un-humanized letters alert', keys({ humanizedLetters: 2, draftLetters: 3 }).includes('humanizer-fallback'));
check('one un-humanized letter among many does not', !keys({ humanizedLetters: 9, draftLetters: 1 }).includes('humanizer-fallback'));
check('repeated unconfirmed submits alert', keys({ unconfirmedSubmits: 2 }).includes('unconfirmed-submits') && !keys({ unconfirmedSubmits: 1 }).includes('unconfirmed-submits'));
check('three failed runs in a row alert', keys({ failedRunsInARow: 3 }).includes('runs-failing') && !keys({ failedRunsInARow: 2 }).includes('runs-failing'));
check('a duplicate application alerts and names it', operatorAlertsFor({ ...calm, duplicateApplications: [{ email: 'a@b.c', company: 'Menrva', title: 'Support', times: 2 }] })
  .some((alert) => alert.key === 'duplicate-applications' && alert.message.paragraphs.some((p) => p.includes('Menrva'))));

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
