import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CostMeter, CelerisRetryDeadlineError, type CelerisRequest, type CelerisReply } from './celeris.js';
import { PersonalAnswerCheck, checkedPersonalReviews, personalAnswers, type PersonalAnswer } from './personal-answer-check.js';
import type { SavedForm } from './saved-form.js';
import type { ToolContext } from './context.js';
import { isSubmitControl } from '../llm.js';
import { withApplicationModel } from '../application-model.js';

const ctx = (): ToolContext => ({
  page: new Proxy({}, { get() { throw new Error('The audit must not execute browser actions'); } }),
  profile: { name: 'Synthetic Candidate', skills: [] }, captured: [], actions: [], log: () => {},
} as unknown as ToolContext);
const form = (answer = 'No', required = true): SavedForm => ({ url: 'https://employer.invalid/apply', text: 'Do you have a disability?', fields: [
  { ref: 'frame0:f1', localRef: 'f1', frame: 0, label: 'Do you have a disability?', currentValue: answer, required, kind: 'select', options: ['Yes', 'No', 'Prefer not to say'] },
] });
const reply = (reviews: unknown[]): CelerisReply => ({ text: JSON.stringify({ reviews }), toolCalls: [], message: { role: 'assistant', content: '' } });
const review = (id: string, basis: string, citations: unknown[] = []) => ({ id, basis, reason: 'Controlled evidence result', citations });

test('unsupported negative personal declaration stops before submission with the actual question and choices', async () => {
  const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000, sources: async () => [],
    chat: async request => {
      assert.equal(request.tools, undefined);
      assert.ok(request.deadline! <= Date.now() + 45_000);
      assert.ok(request.maxTokens! <= 8192);
      const payload = JSON.parse(String(request.messages[1].content));
      assert.equal(payload.answers[0].answer, 'No');
      return reply([review('field:0', 'missing')]);
    } });
  const result = await check.check(ctx(), form());
  assert.equal(result?.kind, 'terminal');
  assert.ok(result?.kind === 'terminal' && result.outcome.status === 'needs-human');
  assert.equal(result.outcome.questions?.[0].question, 'Do you have a disability?');
  assert.deepEqual(result.outcome.questions?.[0].options, ['Yes', 'No', 'Prefer not to say']);
});

test('evidence-grounded results are cached; changed answers, evidence or destination force a new check', async () => {
  let calls = 0, source = 'Disability: No. Confirmed by candidate.';
  const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000,
    sources: async () => [{ id: 'saved:1', text: source }], chat: async () => {
      calls++; return reply([review('field:0', 'supported', [{ source: 'saved:1', quote: source }])]);
    } });
  assert.equal(await check.check(ctx(), form()), null);
  assert.equal(await check.check(ctx(), form()), null);
  assert.equal(calls, 1);
  await check.check(ctx(), form('Yes')); assert.equal(calls, 2);
  source = 'Updated explicit candidate fact';
  await check.check(ctx(), form('Yes')); assert.equal(calls, 3);
  await check.check(ctx(), { ...form('Yes'), url: 'https://other.invalid/apply' }); assert.equal(calls, 4);
});

test('missing, duplicated, fabricated and uncited reviews cannot authorise submission', () => {
  const answers: PersonalAnswer[] = [{ id: 'field:0', question: 'Disability', answer: 'No', required: true }];
  const sources = [{ id: 'saved', text: 'No medical conditions affecting this role.' }];
  for (const reviews of [[], [review('wrong', 'routine')], [review('field:0', 'routine'), review('field:0', 'routine')],
    [review('field:0', 'supported')], [review('field:0', 'supported', [{ source: 'page', quote: 'No' }])],
    [review('field:0', 'supported', [{ source: 'saved', quote: 'No disability' }])]]) {
    assert.throws(() => checkedPersonalReviews({ reviews }, answers, sources));
  }
});

test('unavailable checks are technical skips, never invented questions; optional unknowns ask the applier to clear them', async () => {
  for (const chat of [async () => { throw new Error('Provider unavailable'); }, async () => reply([])]) {
    const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000, sources: async () => [], chat });
    const result = await check.check(ctx(), form());
    assert.ok(result?.kind === 'terminal' && result.outcome.status === 'skipped');
    assert.match(result.outcome.reason, /Nothing was submitted/);
  }
  const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000, sources: async () => [],
    chat: async () => reply([review('field:0', 'missing')]) });
  const result = await check.check(ctx(), form('No', false));
  assert.ok(result?.kind === 'ok' && result.disposition === 'failed');
  assert.match(result.message, /clear optional unknown/);
});

test('fresh values override stale notes, cleared fields stay cleared, and prior wizard facts remain reviewable', async () => {
  const context = ctx(); context.captured = [{ question: 'Do you have a disability?', answer: 'Yes' }];
  assert.equal(personalAnswers(context, form())[0].answer, 'No');
  assert.equal(personalAnswers(context, form('')).length, 0);
  let payload: { answers: PersonalAnswer[] } | undefined;
  const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000, sources: async () => [],
    chat: async request => { payload = JSON.parse(String(request.messages[1].content)); return reply(payload!.answers.map(answer => review(answer.id, 'missing'))); } });
  check.remember(form());
  const result = await check.check(ctx(), { url: 'https://employer.invalid/review', text: 'Review', fields: [] });
  assert.equal(payload?.answers[0].answer, 'No');
  assert.ok(result?.kind === 'terminal' && result.outcome.status === 'needs-human');
});

test('verification codes, credentials and file inputs do not become reusable personal evidence', async () => {
  let payload: { answers: PersonalAnswer[] } | undefined;
  const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000, sources: async () => [], chat: async request => {
    payload = JSON.parse(String(request.messages[1].content)); return reply(payload!.answers.map(answer => review(answer.id, 'missing')));
  } });
  check.remember({ fields: [...form().fields, { ref: 'f2', label: 'Verification code', kind: 'text', required: true, currentValue: '123456' },
    { ref: 'f3', label: 'Password', inputType: 'password', kind: 'text', required: true, currentValue: 'fixture-secret' }] });
  await check.check(ctx(), { url: 'https://employer.invalid/review', text: 'Review', fields: [] });
  assert.doesNotMatch(JSON.stringify(payload), /123456|fixture-secret/);
});

test('equal labels in separate frames retain distinct historical answers', async () => {
  let seen: PersonalAnswer[] = [];
  const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000, sources: async () => [], chat: async request => {
    seen = JSON.parse(String(request.messages[1].content)).answers;
    return reply(seen.map(answer => review(answer.id, 'routine')));
  } });
  await check.check(ctx(), { ...form(), fields: [form().fields[0], { ...form('Yes').fields[0], frame: 1, ref: 'frame1:f1' }] });
  await check.check(ctx(), { url: 'https://employer.invalid/review', text: 'Review', fields: [] });
  assert.deepEqual(seen.map(answer => answer.answer).sort(), ['No', 'Yes']);
});

test('no new model call starts after the shared spending or time budget ends', async () => {
  let calls = 0;
  const chat = async (_request: CelerisRequest) => { calls++; return reply([]); };
  const meter = new CostMeter(.01); meter.recordProvider({ prompt: 0, cached: 0, completion: 0, amountUsd: .02 });
  for (const options of [{ meter, remainingMs: () => 120_000 }, { meter: new CostMeter(1), remainingMs: () => 1000 }]) {
    const result = await new PersonalAnswerCheck({ ...options, sources: async () => [], chat }).check(ctx(), form());
    assert.ok(result?.kind === 'terminal' && result.outcome.status === 'skipped');
  }
  assert.equal(calls, 0);
});

test('automatic send classification charges the same application meter with bounded output', async () => {
  const originalFetch = globalThis.fetch, meter = new CostMeter(1);
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 128);
    return Response.json({ choices: [{ message: { content: '{"sends_application":true}' } }], usage: { prompt_tokens: 1000, completion_tokens: 10 } });
  };
  try {
    const sends = await withApplicationModel({ CELERIS_API_KEY: 'fixture-only', APPLICATION_AI_MODEL: 'celeris', COST_TRACKING: 'false' }, () =>
      isSubmitControl({ label: 'Submit application' }, { url: 'https://fixture.invalid', title: 'Review application', text: '', fields: 2, entered: 2 }, { meter, deadline: Date.now() + 10_000 }));
    assert.equal(sends, true);
    assert.equal(meter.totals.calls, 1);
    assert.ok(meter.totals.costUsd > 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('large forms use bounded groups, retain completed checks after a failure, and never approve a partial review', async () => {
  const large = { ...form(), fields: Array.from({ length: 29 }, (_, i) => ({ ...form().fields[0], label: `Personal question ${i}`, ref: `f${i}` })) };
  const seen: string[][] = [];
  let fail = true;
  const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000, sources: async () => [], chat: async request => {
    const answers: PersonalAnswer[] = JSON.parse(String(request.messages[1].content)).answers;
    assert.ok(answers.length <= 12);
    seen.push(answers.map(answer => answer.id));
    if (seen.length === 2 && fail) throw new Error('Provider timed out');
    return reply(answers.map(answer => review(answer.id, 'routine')));
  } });
  const first = await check.check(ctx(), large);
  assert.ok(first?.kind === 'terminal' && first.outcome.status === 'skipped');
  fail = false;
  assert.equal(await check.check(ctx(), large), null);
  assert.deepEqual(seen.map(group => group.length), [12, 12, 12, 5]);
  assert.deepEqual(seen[1], seen[2]);
  // A changed answer invalidates its group, while identical groups stay cached.
  large.fields[0].currentValue = 'Yes';
  assert.equal(await check.check(ctx(), large), null);
  assert.equal(seen.length, 5);
});

test('a missing consequential answer in the final group blocks the whole form', async () => {
  const large = { ...form(), fields: Array.from({ length: 13 }, (_, i) => ({ ...form().fields[0], label: `Personal question ${i}`, ref: `f${i}` })) };
  const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000, sources: async () => [], chat: async request => {
    const answers: PersonalAnswer[] = JSON.parse(String(request.messages[1].content)).answers;
    return reply(answers.map(answer => review(answer.id, answer.id === 'field:12' ? 'missing' : 'routine')));
  } });
  const result = await check.check(ctx(), large);
  assert.ok(result?.kind === 'terminal' && result.outcome.status === 'needs-human');
  assert.equal(result.outcome.questions?.[0].question, 'Personal question 12');
});

test('a transient provider deadline allows one read-only retry while retaining the filled form; repeated failure stops', async () => {
  let calls = 0;
  const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000, sources: async () => [],
    chat: async () => { calls++; throw new CelerisRetryDeadlineError('Provider timeout; no retry time remains'); } });
  const first = await check.check(ctx(), form());
  assert.ok(first?.kind === 'ok' && first.disposition === 'failed');
  assert.match(first.message, /without refilling/);
  const second = await check.check(ctx(), form());
  assert.ok(second?.kind === 'terminal' && second.outcome.status === 'skipped');
  assert.equal(calls, 2);
});

test('invalid source quotes get one read-only correction and still require exact binding', async () => {
  for (const repair of [true, false]) {
    let calls = 0;
    const check = new PersonalAnswerCheck({ meter: new CostMeter(1), remainingMs: () => 120_000,
      sources: async () => [{ id: 'saved', text: 'Question: Disability\nAnswer: No' }], chat: async request => {
        calls++;
        if (calls === 2) assert.match(String(request.messages.at(-1)?.content), /failed validation/);
        return reply([review('field:0', 'supported', [{ source: 'saved', quote: repair && calls === 2 ? 'Question: Disability\nAnswer: No' : 'Question: Disability / Answer: No' }])]);
      } });
    const result = await check.check(ctx(), form());
    if (repair) assert.equal(result, null);
    else assert.ok(result?.kind === 'terminal' && result.outcome.status === 'skipped');
    assert.equal(calls, 2);
  }
});
