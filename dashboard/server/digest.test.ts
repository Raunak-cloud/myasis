import { renderDigest, worthSending, digestDue, digestConfig, type Digest } from './digest.js';

/**
 * The summary is the only thing a scheduled account ever hears from us, so
 * what it says matters as much as that it sends. These check the wording for
 * the days that actually happen — a good one, a stalled one, an empty one —
 * and that an installation without a mail key stays silent rather than
 * throwing every minute after nine.
 */

let bad = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const base: Digest = {
  userId: '1',
  email: 'someone@example.com',
  name: 'Rinu Thapa',
  runs: 4,
  applications: [],
  needsAnswer: 0,
  failed: 0,
};

const good: Digest = {
  ...base,
  applications: [
    { title: 'Medical Receptionist', company: 'Paddington Doctors', external: false },
    { title: 'Ward Clerk', company: 'Vision X-ray Group', external: false },
    { title: 'Retail Assistant', company: 'Nespresso', external: true },
  ],
  needsAnswer: 2,
};

const rendered = renderDigest(good, 'https://myasis.app');
console.log(`subject: ${rendered.subject}\n`);
console.log(rendered.text);
console.log('');

check('subject leads with what was sent', rendered.subject === '3 applications sent today', rendered.subject);
check('greets by first name', rendered.text.startsWith('Hi Rinu,'));
check('capitalises a lowercase name', renderDigest({ ...good, name: 'rinu thapa' }, 'x').text.startsWith('Hi Rinu,'));
check('copes with no name at all', renderDigest({ ...good, name: null }, 'x').text.startsWith('Hi,'));
check('lists every application', good.applications.every((a) => rendered.text.includes(a.title)));
check('marks the employer-site one', rendered.text.includes("(employer's own site)"));
check('mentions what needs answering', /2 jobs stopped on a question/.test(rendered.text));
check('links to the dashboard', rendered.text.includes('https://myasis.app') && rendered.html.includes('https://myasis.app'));
check('html escapes nothing dangerous', !rendered.html.includes('<script'));

// A day that produced nothing but questions.
const stalled = renderDigest({ ...base, runs: 4, needsAnswer: 3 }, 'https://myasis.app');
check('a stalled day leads with the questions', stalled.subject === '3 jobs need your answer', stalled.subject);
check('and says no applications went out', /did not send any applications/.test(stalled.text));

// Singulars, because "1 applications" is the kind of thing people notice.
const single = renderDigest({ ...base, runs: 1, applications: [good.applications[0]], needsAnswer: 1 }, 'https://myasis.app');
check('singular application', single.subject === '1 application sent today', single.subject);
check('singular run', /across 1 run\b/.test(single.text), single.text.split('\n')[2]);
check('singular job', /^1 job stopped/m.test(single.text));

// When to send at all.
check('an empty day is not worth sending', !worthSending({ ...base, runs: 0 }));
check('a day with runs is worth sending', worthSending({ ...base, runs: 2 }));
check('a day with only questions is worth sending', worthSending({ ...base, runs: 0, needsAnswer: 1 }));

// Timing, in Sydney terms.
const at = (iso: string) => new Date(iso);
check('not due at 8pm Sydney', !digestDue(at('2026-09-12T10:00:00Z')));
check('due at 9pm Sydney', digestDue(at('2026-09-12T11:00:00Z')));
check('still due at 11pm Sydney', digestDue(at('2026-09-12T13:00:00Z')));

// An installation with no key must simply do nothing.
const configured = digestConfig();
check('no mail settings means no configuration', configured === null || Boolean(configured.apiKey && configured.from));

console.log(`\n${bad} failure(s)`);
process.exit(bad ? 1 : 0);
