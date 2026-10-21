import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from './celeris.js';
import { agentOnlyTranscript } from './agent-only-transcript.js';

test('Celeris retains candidate facts, authored actions and current state while retiring superseded DOM trees', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Sole applying agent' },
    { role: 'user', content: 'CANONICAL_CANDIDATE_CV_AND_JOB' },
    { role: 'user', content: 'URL: https://fixture.invalid/one\nOLD_OBSERVATION_' + 'irrelevant DOM '.repeat(4000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'snap-old', type: 'function', function: { name: 'take_snapshot', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'snap-old', content: 'OLD_SNAPSHOT_' + 'old tree '.repeat(4000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'fill-name', type: 'function', function: { name: 'browser_action', arguments: '{"action":"fill","value":"Saved candidate answer"}' } }] },
    { role: 'tool', tool_call_id: 'fill-name', content: 'Action executed' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'snap-current', type: 'function', function: { name: 'take_snapshot', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'snap-current', content: 'CURRENT_SNAPSHOT_REFS_AND_VALUES' },
    { role: 'user', content: 'URL: https://fixture.invalid/two\nCURRENT_OBSERVATION_AND_RECORDED_DRAFT' },
  ];
  const before = JSON.stringify(messages);
  const payload = JSON.stringify(agentOnlyTranscript(messages, 42_000));
  assert.match(payload, /CANONICAL_CANDIDATE_CV_AND_JOB/);
  assert.match(payload, /Saved candidate answer/);
  assert.match(payload, /CURRENT_SNAPSHOT_REFS_AND_VALUES/);
  assert.match(payload, /CURRENT_OBSERVATION_AND_RECORDED_DRAFT/);
  assert.doesNotMatch(payload, /OLD_OBSERVATION_|OLD_SNAPSHOT_/);
  assert.ok(payload.length < before.length / 10, 'large superseded trees no longer inflate every turn');
  assert.equal(JSON.stringify(messages), before, 'original audit conversation is unchanged');
});

test('durable approval content survives both superseded observations and token-budget trimming', () => {
  const approval = 'SUBMIT ONLY THIS APPROVED APPLICATION ' + JSON.stringify({ revision: 'immutable-version', coverLetter: 'Exact user-edited letter', answers: [{ question: 'Exact recorded question', answer: 'Approved answer' }] });
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Sole applying agent' },
    { role: 'user', content: `AUTHORITATIVE CANDIDATE PROFILE\n${approval}` },
    ...Array.from({ length: 10 }, (_, index): ChatMessage[] => [
      { role: 'user', content: `URL: https://fixture.invalid/${index}\n${'Old DOM '.repeat(2000)}` },
      { role: 'assistant', content: 'Old reasoning '.repeat(2000) },
    ]).flat(),
    { role: 'user', content: 'URL: https://fixture.invalid/final\nCURRENT_STATE' },
  ];
  const transcript = agentOnlyTranscript(messages, 1000);
  assert.equal(transcript[1].content, messages[1].content);
  assert.ok(String(transcript[1].content).includes(approval));
  assert.match(JSON.stringify(transcript), /earlier steps omitted/);
  assert.match(JSON.stringify(transcript), /CURRENT_STATE/);
});
