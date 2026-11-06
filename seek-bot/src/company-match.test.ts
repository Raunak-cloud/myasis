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

check('ignores legal suffixes', matchingExcludedCompany('Acme Pty Ltd', ['Acme']), 'Acme');
check('leaves missing letters for AI', matchingExcludedCompany('Commonwealth Bank of Australia', ['Commonweath Bank']), null);
check('leaves transposed letters for AI', matchingExcludedCompany('Canva Pty Ltd', ['Cavna']), null);
check('leaves acronym identity for AI', matchingExcludedCompany('Commonwealth Bank of Australia', ['CBA']), null);
check('leaves parent/division identity for AI', matchingExcludedCompany('Amazon Web Services', ['Amazon']), null);
check('matches joined exclusion words', matchingExcludedCompany('TPG Telecom', ['tpgtelecom']), 'tpgtelecom');
check('matches joined advertised words', matchingExcludedCompany('InsightTimer Pty Ltd', ['Insight Timer']), 'Insight Timer');
check('matches spacing and legal suffix variations', matchingExcludedCompany('Insight Timer Limited', ['InsightTimer']), 'InsightTimer');
check('does not use a partial compact name', matchingExcludedCompany('TPG Telecommunications', ['tpgtelecom']), null);
check('does not fuzz a compact name into another employer', matchingExcludedCompany('Insight Timers', ['InsightTimer']), null);
check('does not fuzz short names', matchingExcludedCompany('NIB', ['NAB']), null);
check('does not confuse similar ordinary names', matchingExcludedCompany('Apply Digital', ['Apple']), null);
check('does not treat a generic sector word as an excluded brand', matchingExcludedCompany('Vanguard Cyber', ['CyberCX']), null);
check('still excludes the exact distinctive brand', matchingExcludedCompany('CyberCX Pty Ltd', ['CyberCX']), 'CyberCX');
check('leaves distinctive-brand typos for AI', matchingExcludedCompany('CyberCX', ['CybrCX']), null);
check('does not interpret regex characters', matchingExcludedCompany('Acme', ['A.*']), null);

check('does not exclude WesTrac for Westpac', matchingExcludedCompany('WesTrac Pty Ltd',['Westpac Group']), null);
check('keeps meaningful internal company words', matchingExcludedCompany('The Company Store',['The Store']), null);
check('does not assume group ownership', matchingExcludedCompany('Westpac Banking Corporation',['Westpac Group']), null);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
