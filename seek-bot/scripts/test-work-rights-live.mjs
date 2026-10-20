// Opt-in paid semantic regression check. Synthetic profiles only; no browser
// actions, account writes or employer submissions are executed.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { withApplicationModel } from '../dist/application-model.js';
import { celerisChat, CostMeter } from '../dist/agent/celeris.js';
import { AGENT_ONLY_PROMPT } from '../dist/agent/agent-only.js';

const cases = [
  { name: 'saved Australian citizen', profile: { workRights: 'Citizen', workRightsCountry: 'Australia' }, answer: 'Yes' },
  { name: 'saved Australian permanent resident', profile: { workRights: 'Permanent resident', workRightsCountry: 'Australia' }, question: 'Do you have unrestricted working rights in Australia?', answer: 'Yes' },
  { name: 'full-rights visa with explicit visa exclusion', profile: { workRights: 'Visa with full work rights', workRightsCountry: 'Australia' }, answer: 'No' },
  { name: 'foreign citizenship is not Australian permission', profile: { workRights: 'Citizen', workRightsCountry: 'Canada' }, answer: 'needs-human' },
  { name: 'nationality alone is not work permission', profile: { nationality: 'Nepali' }, answer: 'needs-human' },
];
const tools = [{ name: 'record_test_answer', description: 'Record an answer in this inert synthetic test. No form or account is changed.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    answer: { type: 'string', enum: ['Yes', 'No', 'needs-human'] }, reason: { type: 'string' },
  }, required: ['answer', 'reason'] } }];
await withApplicationModel({ ...process.env, APPLICATION_AI_MODEL: 'celeris', COST_TRACKING: 'false' }, async () => {
  const meter = new CostMeter(Infinity);
  for (const fixture of cases) {
    const start = performance.now();
    const reply = await celerisChat({ model: 'celeris-1-magnus', requireTool: true, reasoningEffort: 'medium', tools, meter,
      messages: [{ role: 'system', content: AGENT_ONLY_PROMPT }, { role: 'user', content:
        `Inert independent synthetic form test. No browser exists; use record_test_answer once instead of browser actions or finish. All candidate evidence is supplied here: ${JSON.stringify({ name: 'Synthetic Candidate', nationality: 'Not stated', ...fixture.profile })}. Required question: ${JSON.stringify(fixture.question ?? "Do you have full working rights in Australia? Please select NO, if you're on a visa.")}. There are no other saved answers or documents. Record Yes, No or needs-human using the production evidence rules.` }] });
    const call = reply.toolCalls[0];
    console.log(JSON.stringify({ case: fixture.name, pass: call?.args.answer === fixture.answer,
      seconds: +((performance.now() - start) / 1000).toFixed(2), answer: call?.args.answer, reason: call?.args.reason }));
    assert.equal(reply.toolCalls.length, 1);
    assert.equal(call.name, 'record_test_answer');
    assert.equal(call.args.answer, fixture.answer, fixture.name);
  }
  console.log(JSON.stringify({ passed: cases.length, estimatedAiUsd: meter.totals.costUsd, calls: meter.totals.calls }));
});
