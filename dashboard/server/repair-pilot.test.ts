import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepairPilotDetector } from './repair-pilot.js';

const attemptId = 'e9cf35f9-b0c0-4209-95c6-849c51a774a5';
const event = { id: 'a9cf35f9-b0c0-4209-95c6-849c51a774a5', runStartId: '1081', attemptId, severity: 'warning', category: 'tool_error', tool: 'create_file', message: 'untrusted employer data and private information' };
const next = { ...event, id: 'b9cf35f9-b0c0-4209-95c6-849c51a774a5' };

test('the pilot only emits bounded metadata for repeated failures in the exact admin account', () => {
  for (const detector of [new RepairPilotDetector('183', 'raunak.vision@gmail.com', true), new RepairPilotDetector('1', 'other@example.com', true), new RepairPilotDetector('1', 'raunak.vision@gmail.com', false)]) {
    assert.equal(detector.observe('1081', event), null);
    assert.equal(detector.observe('1081', event), null);
  }
  const detector = new RepairPilotDetector('1', 'raunak.vision@gmail.com', true);
  assert.equal(detector.observe('1080', event), null);
  assert.equal(detector.observe('1081', event), null);
  assert.equal(detector.observe('1081', event), null, 'replayed diagnostic ids cannot create a false repeated failure');
  const incident = detector.observe('1081', next);
  assert.deepEqual(incident, { runId: '1081', attemptId, category: 'repeated_tool_failure', tool: 'create_file', count: 2 });
  assert.doesNotMatch(JSON.stringify(incident), /private information|untrusted employer/);
  assert.equal(detector.observe('1081', event), null, 'one incident is emitted per repeated failure');
});

test('provider failures, security challenges and malformed identifiers do not trigger code changes', () => {
  const detector = new RepairPilotDetector('1', 'raunak.vision@gmail.com', true);
  for (const category of ['provider_error', 'budget_exhausted', 'captcha', 'stale_target']) {
    assert.equal(detector.observe('1081', { ...event, category }), null);
    assert.equal(detector.observe('1081', { ...event, category }), null);
  }
  assert.equal(detector.observe('1081', { ...event, attemptId: '../../other-account' }), null);
  assert.equal(detector.observe('1081', { ...event, id: 'c9cf35f9-b0c0-4209-95c6-849c51a774a5', category: 'application_exception', severity: 'error' })?.category, 'application_exception');
});
