import assert from 'node:assert/strict';
import { annualSalaryAmount, EXPECTED_SALARY_REQUIRED } from '../src/salary.js';
import { EMPTY_PROFILE, profileGaps } from './candidate-profile.js';
import { getPool } from './db/index.js';
import { saveProfile, SalaryValidationError } from './profile.js';
import { runner, type RunMode } from './runner.js';
import { expectedSalaryRefusal, startRun } from './start-run.js';

const complete = { ...EMPTY_PROFILE, fullName: 'Test Candidate', email: 'test@example.com', phone: '0400000000', workRights: 'Citizen', experienceSummary: 'Software developer' };
for (const [input, expected] of [['150000', 150000], ['150,000', 150000], ['$150,000', 150000], ['AUD 150000', 150000], ['A$150000', 150000], ['150k', 150000], [' 150.5K ', 150500]] as const) {
  assert.equal(annualSalaryAmount(input), expected, input);
  assert.deepEqual(profileGaps({ ...complete, expectedSalary: input }), []);
  assert.equal(expectedSalaryRefusal({ expectedSalary: input }), null);
}
const invalid = ['', ' ', 'Negotiable', '150000-180000', '80/hour', '0', '-150000', 'NaN', 'Infinity', '15,00', '9007199254740992'];
for (const input of invalid) {
  assert.equal(annualSalaryAmount(input), null, input);
  assert.ok(profileGaps({ ...complete, expectedSalary: input }).some((gap) => gap.includes('salary')), input);
}

// Stub the database boundary. Any write or unexpected preparation query fails;
// no browser, credits, run record or process may be touched for missing salary.
const pool = getPool();
const originalQuery = pool.query;
let salary = '';
let writes = 0;
pool.query = (async (sql: string) => {
  assert.match(sql.trim(), /^(?:SELECT|WITH)/i, 'run refusal must not write');
  if (sql.includes('SELECT * FROM profiles')) return { rows: [{ expected_salary: salary }] };
  if (sql.includes('FROM monthly_application_usage')) return { rows: [{ used: '0' }] };
  if (sql.includes('FROM run_starts') || sql.includes('FROM feature_uses') || sql.includes('FROM applications')) return { rows: [{ n: '0', complete: false }] };
  if (sql.includes('FROM settings') || sql.includes('FROM account_overrides') || sql.includes('application_credit_grants')) return { rows: [] };
  throw new Error(`Unexpected query before salary refusal: ${sql}`);
}) as typeof originalQuery;
try {
  for (salary of ['', 'Negotiable', '150000-180000']) {
    for (const trigger of ['manual', 'auto', 'admin', 'onboarding'] as const) {
      const modes: RunMode[] = trigger === 'manual' ? ['live'] : ['live', 'search'];
      for (const mode of modes) {
        assert.deepEqual(await startRun({ userId: 'salary-test', mode, trigger }), { ok: false, status: 400, error: EXPECTED_SALARY_REQUIRED });
        assert.equal(runner.inUse('salary-test'), false, 'refusal releases the start claim');
      }
    }
  }
  // An invalid API answer is rejected before a database read or write.
  pool.query = (async () => { throw new Error('Invalid salary reached database'); }) as typeof originalQuery;
  await assert.rejects(saveProfile('salary-test', { expectedSalary: 'Negotiable' }), SalaryValidationError);

  pool.query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT * FROM profiles')) return { rows: [] };
    if (sql.includes('INSERT INTO profiles')) {
      writes += 1;
      assert.ok(params?.includes(writes === 1 ? '150000' : ''), 'normalises a numeric answer; permits incomplete drafts');
      return { rows: [] };
    }
    throw new Error(`Unexpected profile query: ${sql}`);
  }) as typeof originalQuery;
  assert.equal((await saveProfile('salary-test', { expectedSalary: '$150,000' })).expectedSalary, '150000');
  assert.equal((await saveProfile('salary-test', { expectedSalary: '' })).expectedSalary, '');
  assert.equal(writes, 2);
} finally {
  pool.query = originalQuery;
  await pool.end();
}
console.log('PASS: numeric salary is required by setup and every run trigger; invalid answers cannot be saved or start a run');
