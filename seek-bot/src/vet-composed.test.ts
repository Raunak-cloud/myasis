import { vetComposed } from './llm.js';
import type { FieldAnswer } from './types.js';

/**
 * The backstop that stands between a mislabelled answer and a false claim on
 * a real application. Every case here is phrasing a model plausibly produces
 * for "Reason for leaving?" or "Why do you want this role?".
 */
const composed = (value: string): FieldAnswer => ({ ref: 'f0', value, grounded: true, basis: 'composed' });

const CASES: Array<{ answer: FieldAnswer; keep: boolean; why: string }> = [
  { answer: composed('Seeking a role with more responsibility in health administration.'), keep: true, why: 'neutral forward-looking reason' },
  { answer: composed('I am drawn to your focus on patient care and would bring careful attention to records.'), keep: true, why: 'motivation, no claim' },
  { answer: composed('I have 5 years of experience in retail.'), keep: false, why: 'a quantity of experience' },
  { answer: composed('I have over 3 yrs in customer service.'), keep: false, why: 'a quantity, abbreviated' },
  { answer: composed('I hold a current first aid certificate.'), keep: false, why: 'a credential' },
  { answer: composed('I am an Australian citizen with full working rights.'), keep: false, why: 'work rights' },
  { answer: composed('I have a valid Working With Children check.'), keep: false, why: 'a background check' },
  { answer: composed('I am registered with AHPRA.'), keep: false, why: 'a registration' },
  { answer: { ref: 'f1', value: 'Yes', grounded: true, basis: 'profile' }, keep: true, why: 'profile answers are not vetted here' },
];

let bad = 0;
for (const { answer, keep, why } of CASES) {
  const out = vetComposed(answer);
  const ok = out.grounded === keep;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${keep ? 'keeps ' : 'blocks'}  ${why}`);
}

// An unanswerable field must stay unanswerable whatever else it carries.
const none = vetComposed({ ref: 'f2', value: 'something', grounded: true, basis: 'none' });
const ok = none.grounded === false;
if (!ok) bad++;
console.log(`${ok ? 'PASS' : 'FAIL'}  blocks  basis "none" can never be filled`);

console.log(`\n${CASES.length + 1 - bad}/${CASES.length + 1} passed`);
process.exit(bad ? 1 : 0);
