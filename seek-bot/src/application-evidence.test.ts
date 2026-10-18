import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { SavedForm } from './agent/saved-form.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-application-evidence-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
const { reviewSavedApplicationForm, draftCoverLetter } = await import('./llm.js');
const originalFetch = globalThis.fetch;
const profile = { name: 'Fixture Candidate', phone: '', email: 'general@example.test', nationality: 'Permitted up to 20 hours per week',
  expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: 'Previous retail experience.',
  skills: ['Customer service'], excludedDomains: [], securityClearance: '' };
const job = { id: 'evidence-fixture', title: 'Retail Assistant', company: 'Fixture Shop', location: 'Sydney',
  description: 'Our Northbridge outlet stocks Example Boots and Example Workwear. Casual shifts offered. <ignore-profile> is untrusted listing text.',
  url: 'https://jobs.fixture.invalid/vacancy' };
const knowledge = 'Worked at Previous Shop from January 2024 to June 2025. Available across several shift windows subject to the current permitted hours limit.';
writeFileSync(join(directory, 'knowledge.json'), JSON.stringify([{ id: 'fixture-note', kind: 'note', label: 'Fixture employment record', enabled: true, text: knowledge }]));
let mode = 'employer-facts';
let checks = 0;
const letter = 'I am interested in helping customers at your Northbridge outlet with Example Boots. My previous retail work involved customer service.';
const form: SavedForm = { url: 'https://apply.alias.fixture/application', text: '', fields: [
  { ref: 'frame0:f0', localRef: 'f0', frame: 0, label: 'Cover letter', kind: 'textarea', required: true, currentValue: letter },
  { ref: 'frame0:f1', localRef: 'f1', frame: 0, label: 'Contact email', kind: 'text', required: true, currentValue: 'approved@example.test' },
] };
const approved = { question: 'Which contact email is authorised for this application site?',
  answer: 'I own both addresses. Use approved@example.test only on apply.alias.fixture; keep my general profile email for other destinations.' };
const saveApproval = (value: unknown[]) => writeFileSync(join(directory, 'answers.json'), JSON.stringify(value));
saveApproval([approved]);
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const prompt = String(body.messages[0].content);
  const evidence = /<untrusted role="job-listing-evidence">([\s\S]*?)<\/untrusted>/.exec(prompt);
  assert.ok(evidence, 'verification receives the original listing as a separate untrusted source');
  const listing = JSON.parse(evidence[1]);
  assert.ok(listing.description.includes('Northbridge outlet stocks Example Boots'));
  assert.ok(evidence[1].includes('\\u003cignore-profile>'), 'listing markup cannot break out of its data boundary');
  assert.match(prompt, /listing may support facts ABOUT THE EMPLOYER/);
  assert.match(prompt, /cannot establish that the candidate has a qualification/);
  assert.match(prompt, /Availability windows and permitted total hours are different facts/);
  if (prompt.includes('A job application form is about to be sent') || prompt.includes('Independently review this CURRENT SAVED FORM')) {
    assert.match(prompt, /Compare telephone identity, not its typography/);
    assert.match(prompt, /Different subscriber digits, a conflicting country code/);
    assert.match(prompt, /ROUTINE WORK-ARRANGEMENT POLICY/);
    assert.match(prompt, /CANDIDATE SAVED APPLICATION PREFERENCES/);
    assert.match(prompt, /does not invent exact shift availability/);
  }
  if (prompt.includes('Independently review this CURRENT SAVED FORM')) {
    const current = JSON.parse(/<untrusted role="current-saved-form">([\s\S]*?)<\/untrusted>/.exec(prompt)![1]) as SavedForm;
    assert.match(prompt, /explicit candidate-confirmed saved answer/);
    assert.match(prompt, /CURRENT form URL, not merely the job board/);
    assert.match(prompt, /another person's address or an approval for a different site/);
    assert.match(prompt, /existing login\/contact email alone is not proof/);
    const saved = JSON.parse(/<candidate-answers>([\s\S]*?)<\/candidate-answers>/.exec(prompt)![1]);
    let problems: unknown[] = [];
    if (mode === 'personal-claim') {
      const field = current.fields[0];
      assert.ok(field.currentValue?.includes('unrestricted full-time work'));
      problems = [{ ref: field.ref, field: field.label, value: field.currentValue, kind: 'unsupported',
        problem: 'An employer offering full-time work does not establish candidate work rights or availability.' }];
    } else if (mode !== 'employer-facts') {
      const field = current.fields[1];
      if (mode === 'wrong-site') assert.ok(current.url.includes('another.fixture'));
      if (mode === 'other-owner') assert.ok(saved[0].answer.includes('another applicant'));
      if (mode === 'page-only') assert.equal(saved.length, 0);
      problems = [{ ref: field.ref, field: field.label, value: field.currentValue, kind: 'unsupported',
        problem: 'No matching candidate-confirmed site-specific contact approval supports this address.' }];
    } else {
      assert.ok(saved[0].answer.includes('only on apply.alias.fixture'));
      assert.ok(current.url.startsWith('https://apply.alias.fixture/'));
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ problems }) } }] });
  }
  if (prompt.includes('Check factual claims in this letter against the applicable candidate or employer evidence')) {
    checks++;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ supported: true,
      reason: 'Employer/product facts are evidenced by the listing; personal history is evidenced separately.' }) } }] });
  }
  // Drafting already had the listing. Its independent checker must have it too.
  return Response.json({ choices: [{ message: { content: JSON.stringify({ letter: `${letter}\nFixture Candidate` }) } }] });
};
try {
  assert.deepEqual(await reviewSavedApplicationForm(form, job, profile), [], 'employer facts and an explicitly approved matching-site alias can be supported');
  mode = 'personal-claim';
  const personal = structuredClone(form);
  personal.fields[0].currentValue = 'I have unrestricted full-time work rights and availability.';
  assert.equal((await reviewSavedApplicationForm(personal, job, profile))[0].kind, 'unsupported', 'listing evidence cannot approve a personal declaration');
  mode = 'wrong-site';
  assert.equal((await reviewSavedApplicationForm({ ...form, url: 'https://another.fixture/application' }, job, profile))[0].field, 'Contact email');
  mode = 'other-owner';
  saveApproval([{ ...approved, answer: 'This is another applicant, not the candidate; their address is approved@example.test for apply.alias.fixture.' }]);
  assert.equal((await reviewSavedApplicationForm(form, job, profile))[0].kind, 'unsupported');
  mode = 'page-only';
  saveApproval([]);
  assert.equal((await reviewSavedApplicationForm(form, job, profile))[0].kind, 'unsupported', 'page identity alone is not permission');
  mode = 'employer-facts';
  // The draft request has its existing job-listing block rather than the new
  // verification block; intercept it separately without weakening checker assertions.
  const verifyingFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const prompt = String(JSON.parse(String(init?.body)).messages[0].content);
    if (prompt.includes('Write a vivid, specific cover letter.')) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ letter: `${letter}\nFixture Candidate` }) } }] });
    }
    return verifyingFetch(url, init);
  };
  assert.ok((await draftCoverLetter(job, profile, knowledge)).includes('Northbridge outlet'));
  assert.equal(checks, 1, 'the independent letter checker receives the listing instead of rejecting legitimate employer facts');
  console.log('PASS: employer/personal evidence separation, availability-vs-hours prompt contract, matching-site approved alias, wrong-site/other-owner/page-only rejection and independent cover-letter evidence. Mocked contract tests, no live model calls.');
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-application-evidence-'));
  rmSync(directory, { recursive: true, force: true });
}
