import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from './celeris.js';
import { agentOnlyTranscript, latestObservationScreenshotOnly } from './agent-only-transcript.js';
import { estimateTranscriptTokens } from './loop/transcript.js';

test('screenshot testing removes old pictures before compaction while retaining text, approvals and tool history', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'EXACT_APPROVAL_AND_CANDIDATE' },
    { role: 'user', content: [{ type: 'text', text: 'Previously selected Australia' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,OLD' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'fill', type: 'function', function: { name: 'browser_action', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'fill', content: 'Saved value' },
    { role: 'user', content: [{ type: 'text', text: 'Current form' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,NEW' } }] },
  ];
  const original = JSON.stringify(messages);
  const current = latestObservationScreenshotOnly(messages);
  const payload = JSON.stringify(agentOnlyTranscript(current, 42_000));
  assert.doesNotMatch(payload, /base64,OLD/);
  assert.match(payload, /base64,NEW/);
  assert.match(payload, /Previously selected Australia/);
  assert.equal(current[1], messages[1]);
  assert.equal(current[3], messages[3]);
  assert.equal(current[4], messages[4]);
  assert.equal(JSON.stringify(messages), original);
  assert.equal(latestObservationScreenshotOnly(current), current, 'does not rewrite a clean prefix');
  const blocked: ChatMessage[] = [...current, { role: 'user', content: 'Native dialog blocks the page; no screenshot available' }];
  assert.doesNotMatch(JSON.stringify(latestObservationScreenshotOnly(blocked)), /image_url/, 'never passes an old picture as evidence of the current dialog');
});

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
  assert.equal(agentOnlyTranscript(messages, 42_000), messages, 'ordinary turns preserve an unchanged cacheable prefix');
  const payload = JSON.stringify(agentOnlyTranscript(messages, 18_000));
  assert.match(payload, /CANONICAL_CANDIDATE_CV_AND_JOB/);
  assert.match(payload, /Saved candidate answer/);
  assert.match(payload, /CURRENT_SNAPSHOT_REFS_AND_VALUES/);
  assert.match(payload, /CURRENT_OBSERVATION_AND_RECORDED_DRAFT/);
  assert.doesNotMatch(payload, /OLD_OBSERVATION_|OLD_SNAPSHOT_/);
  assert.ok(payload.length < before.length / 10, 'large superseded trees no longer inflate every turn');
  assert.equal(JSON.stringify(messages), before, 'original audit conversation is unchanged');
});

test('recovery and accuracy guidance retain the fresh screenshot and observation through compaction', () => {
  for (const checkpoint of ['RECOVERY CHECKPOINT:', 'APPLICATION ACCURACY CHECKPOINT:']) {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'CANDIDATE' },
      { role: 'user', content: [{ type: 'text', text: 'URL: https://fixture.invalid/old\nOLD_PAGE' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,OLD' } }] },
      { role: 'user', content: [{ type: 'text', text: 'URL: https://fixture.invalid/current\nCURRENT_PAGE_AND_VALIDATION' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,FRESH' } }] },
      { role: 'user', content: checkpoint + ' Review the same current page.' },
    ];
    const current = latestObservationScreenshotOnly(messages);
    const payload = JSON.stringify(agentOnlyTranscript(current, 42_000, true));
    assert.match(payload, /base64,FRESH/);
    assert.doesNotMatch(payload, /base64,OLD/);
    assert.match(payload, /CURRENT_PAGE_AND_VALIDATION/);
    assert.match(payload, /Review the same current page/);
    const newerPage: ChatMessage[] = [...current, { role: 'user', content: 'New browser observation without a screenshot' }];
    assert.doesNotMatch(JSON.stringify(latestObservationScreenshotOnly(newerPage)), /image_url/);
  }
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

test('image encoding size does not falsely compact the cacheable browser conversation', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Sole applying agent' },
    { role: 'user', content: 'CANDIDATE_AND_APPROVAL' },
    { role: 'user', content: 'URL: https://fixture.invalid/start\nEarlier saved state' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'fill', type: 'function', function: { name: 'browser_action', arguments: '{"action":"fill"}' } }] },
    { role: 'tool', tool_call_id: 'fill', content: 'Saved value' },
    { role: 'user', content: [{ type: 'text', text: 'URL: https://fixture.invalid/current\nCurrent screenshot' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'A'.repeat(500_000) } }] },
  ];
  assert.ok(JSON.stringify(messages).length > 42_000 * 4);
  assert.ok(estimateTranscriptTokens(messages) < 5000);
  assert.equal(agentOnlyTranscript(messages, 42_000), messages, 'retains exact prefix and picture rather than prematurely compacting');
  const smaller: ChatMessage[] = [...messages.slice(0, -1), { role: 'user', content: [{ type: 'text', text: 'URL: https://fixture.invalid/current\nCurrent screenshot' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }];
  assert.equal(estimateTranscriptTokens(smaller), estimateTranscriptTokens(messages), 'recompression bytes are not model text tokens');
  const textHeavy: ChatMessage[] = [...messages, { role: 'user', content: 'CURRENT_TEXT ' + 'x'.repeat(200_000) }];
  assert.notEqual(agentOnlyTranscript(textHeavy, 42_000), textHeavy, 'real text pressure still invokes compaction');
});
