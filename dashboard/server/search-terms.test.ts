import { normalizeGeneratedSearches, splitSearchTerms } from './search-terms.js';

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

const generated = (query: string) => ({
  query,
  resumeEvidence: ['Supported by the résumé'],
  whySomeoneWouldSearchIt: 'Common job-board wording',
});

check(
  'comma-separated current terms become separate exclusions',
  splitSearchTerms('React Developer, Node Engineer').join('|') === 'React Developer|Node Engineer',
);
check(
  'current terms are excluded regardless of case and punctuation',
  normalizeGeneratedSearches(
    [generated('react-developer'), generated('Frontend Engineer')],
    ['React Developer'],
  ).join('|') === 'Frontend Engineer',
);
check(
  'duplicate suggestions are removed while distinct résumé-backed terms remain',
  normalizeGeneratedSearches([
    generated('Data Analyst'),
    generated('data analyst'),
    generated('Reporting Analyst'),
  ]).join('|') === 'Data Analyst|Reporting Analyst',
);
check(
  'work needing an Australian credential the résumé does not show is never suggested',
  normalizeGeneratedSearches([
    { ...generated('Medical Officer'), australianCredentialRequired: 'AHPRA general registration', australianCredentialEvidence: '' },
    { ...generated('General Practitioner'), australianCredentialRequired: 'AHPRA general registration', australianCredentialEvidence: 'Current AHPRA general registration MED000123' },
    { ...generated('Medical Receptionist'), australianCredentialRequired: '', australianCredentialEvidence: '' },
  ]).join('|') === 'General Practitioner|Medical Receptionist',
);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
