import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationMemory } from './application-memory.js';
import { addObservationScreenshot, type Observation } from './observe.js';

test('application memory survives context handoff without prescribing recovery actions', () => {
  const memory = new ApplicationMemory();
  memory.remember('Upload selected. Employer acceptance unknown. Next inspect the attachment list.');
  memory.failed('browser_action', { action: 'click', selector: '#continue' }, 'https://fixture.invalid/form', 'Overlay intercepted click');
  const resumed = new ApplicationMemory(); resumed.restore(memory.checkpoint());
  assert.deepEqual(resumed.checkpoint(), memory.checkpoint());
  assert.match(JSON.stringify(resumed.checkpoint()), /Overlay intercepted click/);
  assert.equal('phase' in resumed.checkpoint(), false);
  assert.equal('specialistPending' in resumed.checkpoint(), false);
  assert.equal(new ApplicationMemory().checkpoint().note, '', 'another application starts with empty memory');
});

test('legacy checkpoints retain useful notes while discarding recovery workflow', () => {
  const memory = new ApplicationMemory();
  memory.restore({ version: 1, note: 'Saved work', failedInteractions: [], phase: 'verify', specialistPending: true });
  assert.deepEqual(memory.checkpoint(), { version: 2, note: 'Saved work', failedInteractions: [] });
});

test('a hung screenshot setup returns control at the 30-second backup deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let commands = 0;
  const page = { evaluate: () => { commands++; return new Promise(() => {}); } };
  const observation = { url: 'https://fixture.invalid/form', title: '', fields: [], actions: [], text: '' } as Observation;
  const pending = addObservationScreenshot(page as never, observation);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(30_000);
  await pending;
  assert.equal(observation.screenshot, undefined);
  assert.equal(commands, 1, 'the expired operation cannot queue more browser work');
});
