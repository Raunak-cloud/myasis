import { matchingExcludedCompany } from './company-match.js';

let failures = 0;
const check = (name: string, actual: string | null, expected: string | null) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  }
};

check('ignores legal suffixes', matchingExcludedCompany('Acme Australia Pty Ltd', ['Acme']), 'Acme');
check('accepts a missing letter', matchingExcludedCompany('Commonwealth Bank of Australia', ['Commonweath Bank']), 'Commonweath Bank');
check('accepts transposed letters', matchingExcludedCompany('Canva Pty Ltd', ['Cavna']), 'Cavna');
check('matches an exact acronym', matchingExcludedCompany('Commonwealth Bank of Australia', ['CBA']), 'CBA');
check('matches a parent name within a division', matchingExcludedCompany('Amazon Web Services', ['Amazon']), 'Amazon');
check('matches joined exclusion words', matchingExcludedCompany('TPG Telecom', ['tpgtelecom']), 'tpgtelecom');
check('matches joined advertised words', matchingExcludedCompany('InsightTimer Pty Ltd', ['Insight Timer']), 'Insight Timer');
check('matches spacing and legal suffix variations', matchingExcludedCompany('Insight Timer Limited', ['InsightTimer']), 'InsightTimer');
check('does not use a partial compact name', matchingExcludedCompany('TPG Telecommunications', ['tpgtelecom']), null);
check('does not fuzz a compact name into another employer', matchingExcludedCompany('Insight Timers', ['InsightTimer']), null);
check('does not fuzz short names', matchingExcludedCompany('NIB', ['NAB']), null);
check('does not confuse similar ordinary names', matchingExcludedCompany('Apply Digital', ['Apple']), null);
check('does not interpret regex characters', matchingExcludedCompany('Acme', ['A.*']), null);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
