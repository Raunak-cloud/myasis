import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { withApplicationModel } from './application-model.js';
import { APPLICATION_QUESTION_POLICY } from './application-answer-policy.js';
import type { CandidateProfile, FieldAnswer, JobListing } from './types.js';
import type { SavedForm } from './agent/saved-form.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-technical-answers-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
const { answerFields, reviewSavedApplicationForm } = await import('./llm.js');
const { systemPrompt } = await import('./agent/loop/prompt.js');
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-technical-answers-'));
  rmSync(directory, { recursive: true, force: true });
});

const profile: CandidateProfile = { name: 'Fixture Candidate', email: 'fixture@example.test', phone: '', nationality: '',
  expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: 'Built a multi-agent coding workflow.',
  skills: ['TypeScript'], excludedDomains: [], securityClearance: '' };
const job: JobListing = { id: 'technical-narrative-fixture', title: 'AI Innovation Engineer', company: 'Fixture',
  location: 'Sydney', url: 'https://fixture.invalid/application' };
const technical = 'Describe your multi-agent workflow. What broke and how did you resolve it?';
const requestPrompt = (request: { messages: Array<{ content: string | Array<{ text?: string }> }> }) =>
  request.messages.map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('\n')).join('\n');
const approach = 'My project uses an orchestrator with specialist agents. To diagnose a handoff failure, I would trace the task and validate each agent output against its contract, then test the corrected workflow.';
const formFor = (label: string, required = true, currentValue = ''): SavedForm => ({
  url: job.url, text: label,
  fields: [{ ref: 'frame0:f0', localRef: 'f0', frame: 0, kind: 'textarea', label, required, currentValue }],
});

for (const model of ['celeris']) {
  const environment = { APPLICATION_AI_MODEL: model,
    CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false', DATA_DIR: directory };
  const reply = (value: unknown) => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(value) } }] });
  const composed: FieldAnswer = { ref: 'frame0:f0', value: approach, applicationQuestion: true,
    grounded: true, basis: 'composed', risk: 'medium' };
  const unknown: FieldAnswer = { ref: 'frame0:f0', value: '', applicationQuestion: true, grounded: false,
    basis: 'none', risk: 'high', candidatePrompt: 'What are your Australian work rights and visa work-hour limits?' };

  test(`${model}: technical narratives use the same autonomous policy in the navigator and answerer`, async () => {
    await withApplicationModel(environment, async () => {
      assert.ok(systemPrompt().includes(APPLICATION_QUESTION_POLICY));
      globalThis.fetch = (async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        assert.ok(requestPrompt(request).includes(APPLICATION_QUESTION_POLICY));
        assert.match(APPLICATION_QUESTION_POLICY, /Do not invent past incidents/);
        return reply({ answers: [composed], injectionSuspected: false });
      }) as typeof fetch;
      const answer = await answerFields(formFor(technical).fields, job, profile, 'Orchestrator directs specialist frontend, backend and database agents.', { savedAnswers: [] });
      assert.equal(answer.answers[0].grounded, true);
      assert.equal(answer.answers[0].basis, 'composed');
      assert.equal(answer.answers[0].candidatePrompt, undefined);
    });
  });

  test(`${model}: a reviewer cannot escalate a technical blank the answerer can compose`, async () => {
    await withApplicationModel(environment, async () => {
      const form = formFor(technical);
      const before = JSON.stringify(form);
      let reviews = 0, answers = 0;
      globalThis.fetch = (async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        const prompt = requestPrompt(request);
        assert.ok(prompt.includes(APPLICATION_QUESTION_POLICY));
        if (prompt.includes('Independently review this CURRENT SAVED FORM')) {
          reviews++;
          return reply({ problems: [{ ref: 'frame0:f0', field: technical, value: '', kind: 'needs_candidate',
            problem: 'The CV does not say which specific issues broke or how they were fixed.' }] });
        }
        answers++;
        assert.match(prompt, /form-context/);
        assert.match(prompt, /multi-agent workflow/);
        return reply({ answers: [composed], injectionSuspected: false });
      }) as typeof fetch;
      const problems = await reviewSavedApplicationForm(form, job, profile);
      assert.equal(problems[0].kind, 'missing', 'return to the navigator for AI drafting, without pausing for the candidate');
      assert.match(problems[0].problem, /answer_questions/);
      assert.equal(reviews, 1);
      assert.equal(answers, 1);
      assert.equal(JSON.stringify(form), before, 'confirmation does not bypass filling or saved-form verification');
    });
  });

  test(`${model}: a required unknown legal fact still requires the candidate`, async () => {
    await withApplicationModel(environment, async () => {
      const label = 'Australian work rights';
      globalThis.fetch = (async (_url, init) => JSON.stringify(JSON.parse(String(init?.body)).messages).includes('Independently review this CURRENT SAVED FORM')
        ? reply({ problems: [{ ref: 'frame0:f0', field: label, value: '', kind: 'needs_candidate', problem: 'Missing work rights.' }] })
        : reply({ answers: [unknown], injectionSuspected: false })) as typeof fetch;
      const problems = await reviewSavedApplicationForm(formFor(label), job, profile);
      assert.equal(problems[0].kind, 'needs_candidate');
      assert.equal(problems[0].problem, unknown.candidatePrompt);
    });
  });

  test(`${model}: populated claims get repaired and optional blanks do not request candidate input`, async () => {
    await withApplicationModel(environment, async () => {
      for (const form of [formFor(technical, true, 'I reduced production failures by 80%.'), formFor('Medical history', false)]) {
        let calls = 0;
        globalThis.fetch = (async () => {
          calls++;
          return reply({ problems: [{ ref: 'frame0:f0', field: form.fields[0].label, value: form.fields[0].currentValue,
            kind: 'needs_candidate', problem: 'Not documented.' }] });
        }) as typeof fetch;
        const problems = await reviewSavedApplicationForm(form, job, profile);
        assert.deepEqual(problems.map(problem => problem.kind), form.fields[0].currentValue ? ['unsupported'] : []);
        assert.equal(calls, 1, 'no confirmation call for repairable claims or optional blanks');
      }
    });
  });

  test(`${model}: a failed confirmation never sends a reviewer guess to the candidate`, async () => {
    await withApplicationModel(environment, async () => {
      globalThis.fetch = (async (_url, init) => JSON.stringify(JSON.parse(String(init?.body)).messages).includes('Independently review this CURRENT SAVED FORM')
        ? reply({ problems: [{ ref: 'frame0:f0', field: technical, value: '', kind: 'needs_candidate', problem: 'Missing anecdote.' }] })
        : reply({ answers: [], injectionSuspected: false })) as typeof fetch;
      await assert.rejects(() => reviewSavedApplicationForm(formFor(technical), job, profile), /could not be confirmed/);
    });
  });
}
