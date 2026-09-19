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

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
