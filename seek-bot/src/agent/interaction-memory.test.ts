import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionMemory } from './interaction-memory.js';

test('failure evidence is bounded, deduplicated and isolated without retaining supplied answers or URL secrets', () => {
  const memory = new InteractionMemory(), other = new InteractionMemory();
  for (let i=0;i<3;i++) memory.failed('browser_action', { action: 'fill', selector: '#contact', value: 'PRIVATE_VALUE' }, 'https://fixture.invalid/apply?token=PRIVATE_TOKEN', 'Input is read-only');
  assert.match(memory.render(), /"count":3/);
  assert.match(memory.render(), /Input is read-only/);
  assert.doesNotMatch(memory.render(), /PRIVATE_/);
  assert.equal(other.render(), '');
  for (let i=0;i<30;i++) memory.failed('browser_action', { action: 'click', ref: `a${i}` }, 'https://fixture.invalid/form', `Failure ${i}`);
  assert.doesNotMatch(memory.render(), /Failure 0"/);
  assert.match(memory.render(), /Failure 29/);
  assert.ok(memory.render().length < 10_000);
});
