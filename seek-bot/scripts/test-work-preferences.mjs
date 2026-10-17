// Live synthetic reasoning evaluation; no employer pages or applications.
// node scripts/test-work-preferences.mjs --live
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
if (!process.argv.includes('--live')) throw new Error('Pass --live to use the configured model with synthetic candidate data.');
const directory = mkdtempSync(join(tmpdir(), 'owtomate-work-preferences-'));
process.env.DATA_DIR = directory;
process.env.FORM_SPEED_PILOT = 'false';
const { config } = await import('../dist/config.js');
const { answerFields, auditFormBeforeSubmit, reviewSavedApplicationForm } = await import('../dist/llm.js');
const officeQuestion = 'This role requires you to be in-office in Sydney at least 3 days a week. Based on this requirement, do you feel comfortable moving forward with this opportunity?';
const profile = { name: 'Synthetic Applicant', suburb: 'Sydney', state: 'NSW', nationality: 'Not supplied', phone: '', email: 'fixture@example.test',
  expectedSalary: 'Negotiable', noticePeriod: '', willingToRelocate: true, experienceSummary: 'Four years of software development.', skills: ['TypeScript'], excludedDomains: [], securityClearance: '' };
const job = { id: 'synthetic-work-preference', title: 'Software Engineer', company: 'Synthetic Employer', location: 'Sydney NSW',
  workArrangement: 'hybrid', description: 'Hybrid software role in Sydney with three office days each week.', url: 'https://work-preference.invalid/job' };
const cases = [
  { name: 'compatible three-day hybrid', arrangements: ['hybrid', 'onsite'], city: 'Sydney', question: officeQuestion, expected: 'Yes' },
  { name: 'remote-only restriction', arrangements: ['remote'], city: 'Sydney', question: officeQuestion, expected: 'No' },
  { name: 'explicit refusal overrides broad settings', arrangements: ['hybrid', 'onsite'], city: 'Sydney', question: officeQuestion, expected: 'No',
    saved: [{ question: officeQuestion, answer: 'No. I cannot attend the office three days a week.' }] },
  { name: 'different city despite relocation flag', arrangements: ['hybrid', 'onsite'], city: 'Melbourne', question: officeQuestion, expected: 'No' },
  { name: 'unknown work-rights declaration', arrangements: ['hybrid', 'onsite'], city: 'Sydney', question: 'Do you currently have unrestricted Australian work rights?', expected: null },
];
let failures = 0;
try {
  for (const scenario of cases) {
    const started = Date.now();
    config.rules.workArrangements = scenario.arrangements;
    config.rules.onsiteCity = scenario.city;
    config.aiInstructions = '';
    writeFileSync(join(directory, 'answers.json'), JSON.stringify(scenario.saved ?? []));
    const field = { ref: 'f0', label: scenario.question, kind: 'radio', required: true, options: ['Yes', 'No'] };
    try {
      const result = await answerFields([field], job, profile);
      const answer = result.answers.find(answer => answer.ref === field.ref);
      assert.ok(answer);
      assert.equal(answer.grounded, scenario.expected !== null, JSON.stringify(answer));
      if (scenario.expected) assert.equal(answer.value, scenario.expected, answer.rationale);
      const form = { url: 'https://work-preference.invalid/application', text: scenario.question, fields: [
        { ...field, ref: 'frame0:f0', localRef: 'f0', frame: 0, currentValue: '' },
      ] };
      const blank = await reviewSavedApplicationForm(form, job, profile);
      assert.ok(blank.some(issue => issue.kind === (scenario.expected ? 'missing' : 'needs_candidate')),
        `Wrong blank-field classification: ${JSON.stringify(blank)}`);
      if (scenario.expected) {
        form.fields[0].currentValue = scenario.expected;
        assert.deepEqual(await reviewSavedApplicationForm(form, job, profile), [], 'compatible answers survive independent saved-form review');
        assert.deepEqual(await auditFormBeforeSubmit(`${scenario.question}: ${scenario.expected}`, job, profile, [], [scenario.question], form.url), [],
          'raw browser answers follow the same preference evidence');
      }
      console.log(`PASS ${scenario.name}: ${Date.now() - started}ms`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${scenario.name}: ${error.message}`);
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
