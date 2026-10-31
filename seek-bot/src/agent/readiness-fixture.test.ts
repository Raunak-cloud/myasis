import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadinessFixtureReply } from './readiness-fixture.js';

const tool = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const checkpoint = (messages: unknown[]) => ({ messages, tool_choice: { type: 'function', function: { name: 'record_application_review' } } });
const readCall = async (response: Response | undefined) => (await response!.json()).choices[0].message.tool_calls[0].function;
const reviewRequest = 'Before this send, review actual saved answers, documents and vacancy with candidate sources using record_application_review. No send was attempted or queued.';

test('readiness fixture resumes the correlated held send instead of earlier fills in the same model reply', async () => {
  const fixture = createReadinessFixtureReply();
  const send = { action: 'click', selector: '#submit', sends_application: true };
  const messages = [
    { role: 'assistant', tool_calls: [tool('name', 'browser_action', { action: 'fill', selector: '#name', value: 'Fixture' }), tool('send', 'browser_action', send)] },
    { role: 'tool', tool_call_id: 'name', content: 'Filled the name field.' },
    { role: 'tool', tool_call_id: 'send', content: reviewRequest },
  ];
  assert.equal((await readCall(fixture(checkpoint(messages)))).name, 'record_application_review');
  assert.equal(fixture({ messages, tool_choice: { function: { name: 'record_recovery_result' } } }), undefined, 'an unrelated forced checkpoint cannot consume or execute the pending send');
  const resumed = await readCall(fixture({ messages }));
  assert.equal(resumed.name, 'browser_action'); assert.deepEqual(JSON.parse(resumed.arguments), send);
  assert.equal(fixture({ messages }), undefined, 'the held send is resumed once without consuming another scripted turn');
});

test('readiness fixture resumes only the stopped batch send and does not replay prefix or tail writes', async () => {
  const fixture = createReadinessFixtureReply();
  const send = { action: 'click', selector: '#submit', sends_application: true };
  const messages = [
    { role: 'assistant', tool_calls: [tool('batch', 'browser_batch', { actions: [{ action: 'fill', selector: '#name', value: 'Fixture' }, send, { action: 'fill', selector: '#after', value: 'Later' }] })] },
    { role: 'tool', tool_call_id: 'batch', content: JSON.stringify({ results: [{ index: 0, kind: 'ok', message: 'Filled.' }, { index: 1, kind: 'ok', message: reviewRequest, disposition: 'reobserve' }], stopped: 1, remainingNotExecuted: true }) },
  ];
  fixture(checkpoint(messages));
  const resumed = await readCall(fixture({ messages }));
  assert.equal(resumed.name, 'browser_action'); assert.deepEqual(JSON.parse(resumed.arguments), send);
});
