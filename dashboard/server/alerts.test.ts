import { alertsFor, renderAlert, type Facts } from './alerts.js';

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

const billing = (totalRemaining: number, pass: boolean): Facts['billing'] => ({
  configured: true,
  free: { allowance: 5, used: pass ? 5 : 5 - totalRemaining, remaining: pass ? 0 : totalRemaining },
  paid: { remaining: pass ? totalRemaining : 0, expiresAt: null, hasActivePass: pass, hasActiveJobSearchPass: pass, hasActiveIntensivePass: false },
  totalRemaining,
});
const healthy: Facts = { billing: billing(120, true), granted: 205, signedOutBoards: [], recentRuns: [], missingSetup: [], hasAutoRuns: true };
const keys = (facts: Facts) => alertsFor(facts).map((alert) => alert.key);

check('a healthy account gets no email', keys(healthy).length === 0);
check('a pass at 21 of 205 left is not yet low', keys({ ...healthy, billing: billing(21, true) }).length === 0);
check('a pass at a tenth left is low', keys({ ...healthy, billing: billing(20, true) }).join() === 'applications-low');
check('the low email says how many are left', alertsFor({ ...healthy, billing: billing(20, true) })[0].message.subject.startsWith('20 applications left'));
check('a free account is told at its last application, not before', keys({ ...healthy, billing: billing(2, false), granted: 5 }).length === 0 && keys({ ...healthy, billing: billing(1, false), granted: 5 }).join() === 'applications-low');
check('an account at zero is told it is out, and not also that it is low', keys({ ...healthy, billing: billing(0, false), granted: 5 }).join() === 'applications-out');

check('a signed-out board is an alert, and waits before it is sent', alertsFor({ ...healthy, signedOutBoards: ['Indeed'] })[0].key === 'board-signed-out' && alertsFor({ ...healthy, signedOutBoards: ['Indeed'] })[0].holdMinutes >= 60);
check('it names the board', alertsFor({ ...healthy, signedOutBoards: ['SEEK', 'Indeed'] })[0].message.subject.startsWith('SEEK and Indeed signed you out'));

const failed = { failed: true, stopped: false };
check('three failed runs in a row is an alert', keys({ ...healthy, recentRuns: [failed, failed, failed] }).join() === 'runs-failing');
check('two are not', keys({ ...healthy, recentRuns: [failed, failed] }).length === 0);
check('a run the person stopped is not a failure', keys({ ...healthy, recentRuns: [failed, { failed: true, stopped: true }, failed] }).length === 0);
check('a success in between resets it', keys({ ...healthy, recentRuns: [failed, { failed: false, stopped: false }, failed] }).length === 0);

check('a paying account that never finished setup is told, after a day', alertsFor({ ...healthy, missingSetup: ['Résumé uploaded'] })[0]?.holdMinutes === 24 * 60);
check('an account with automatic runs switched off is not nagged about setup', keys({ ...healthy, missingSetup: ['Résumé uploaded'], hasAutoRuns: false }).length === 0);

const email = renderAlert(alertsFor({ ...healthy, billing: billing(0, true) })[0].message, 'rinu thapa', 'https://owtomate.com/', 'https://owtomate.com/api/email-alerts/off?u=2&t=abc');
check('the email greets by first name and links to the fix', email.text.startsWith('Hi Rinu,') && email.text.includes('https://owtomate.com/?tab=pricing'));
check('every email carries its own switch-off link', email.html.includes('/api/email-alerts/off?u=2&amp;t=abc') && email.text.includes('Stop these emails'));
check('page text cannot inject markup', !renderAlert({ subject: 's', paragraphs: ['<script>x</script>'], action: { label: 'a', tab: 'run' } }, null, 'https://x', 'https://x/off').html.includes('<script>'));

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
