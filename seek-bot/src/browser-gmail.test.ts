import { extractCode } from './browser-gmail.js';

/**
 * Codes as they actually appear in a Gmail message list.
 *
 * The rows here are copied in the shape the list renders them — sender,
 * subject, then a snippet, all on one line — because that is the only text
 * this ever sees. Testing against tidy subject/body pairs would prove the
 * regex works on input it never gets.
 *
 * The negatives matter more than the positives: a row with a year, an order
 * number or a salary in it must not be mistaken for a code, or the agent will
 * confidently type the wrong six digits into an employer's form.
 */

const CASES: Array<{ line: string; expect: string | null; why: string }> = [
  {
    line: 'Workday - Your verification code - Your verification code is 483920. It expires in 10 minutes.',
    expect: '483920',
    why: 'plain six-digit code after the keyword',
  },
  {
    line: 'Oracle Recruiting - 728104 is your one-time passcode - Use this to continue your application',
    expect: '728104',
    why: 'code before the keyword',
  },
  {
    line: 'SmartRecruiters - Verify your email - Enter code 5D3F9A to confirm your address',
    expect: '5D3F9A',
    why: 'alphanumeric code',
  },
  {
    line: 'Greenhouse - Your PIN is 4821 - Complete your application',
    expect: '4821',
    why: 'four-digit PIN',
  },
  {
    line: 'LinkedIn - Your job alert for 2026 graduate roles - 15 new jobs in Sydney',
    expect: null,
    why: 'a year is not a code',
  },
  {
    line: 'Seek - Application received - Your reference is 20260911 for Software Engineer',
    expect: null,
    why: 'a reference number with no code keyword nearby',
  },
  {
    line: 'Recruiter - Salary range 95000 to 120000 for this position',
    expect: null,
    why: 'salary figures are not codes',
  },
];

let failures = 0;
for (const { line, expect, why } of CASES) {
  const got = extractCode(line);
  const pass = got === expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${JSON.stringify(expect)} <- ${why}${pass ? '' : `  (got ${JSON.stringify(got)})`}`);
}

console.log(`\n${CASES.length - failures}/${CASES.length} passed`);
process.exit(failures ? 1 : 0);
