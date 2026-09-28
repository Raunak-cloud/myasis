import assert from 'node:assert/strict';
import { test } from 'node:test';

async function setup(label) {
  globalThis.__META_PIXEL_ID__ = '163428340971726';
  globalThis.location = { href: 'https://owtomate.com/' };
  globalThis.window = {};
  const scripts = [];
  const beacons = [];
  globalThis.document = {
    createElement: () => ({}),
    head: { appendChild: (script) => scripts.push(script) },
    body: { appendChild: (image) => beacons.push(image) },
  };
  globalThis.Image = class {
    constructor() {}
    remove() {}
  };
  const module = await import(`../src/metaPixel.ts?${label}`);
  return { ...module, scripts, beacons };
}

test('successful SDK load does not also send image beacons', async () => {
  const { initMetaPixel, trackMetaEvent, scripts, beacons } = await setup('loaded');
  initMetaPixel();
  trackMetaEvent('CompleteRegistration', {}, 'signup:test');
  assert.equal(scripts.length, 1);
  scripts[0].onload();
  assert.equal(beacons.length, 0);
  assert.equal(window.fbq.queue.filter((call) => call[0] === 'track').length, 2);
});

test('failed SDK load sends each queued event once via beacon', async () => {
  const { initMetaPixel, trackMetaEvent, scripts, beacons } = await setup('failed');
  initMetaPixel();
  trackMetaEvent('CompleteRegistration', {}, 'signup:test');
  scripts[0].onerror();
  assert.deepEqual(beacons.map((image) => new URL(image.src).searchParams.get('ev')),
    ['PageView', 'CompleteRegistration']);
  assert.equal(new URL(beacons[1].src).searchParams.get('eid'), 'signup:test');
  trackMetaEvent('Purchase', { value: 9.9, currency: 'AUD' }, 'purchase:test');
  assert.equal(beacons.length, 3);
  assert.equal(window.fbq.queue.filter((call) => call[0] === 'track').length, 2);
});

test('an existing SDK receives events without injecting another script or beacon', async () => {
  const { initMetaPixel, trackMetaEvent, scripts, beacons } = await setup('existing');
  const calls = [];
  window.fbq = (...args) => calls.push(args);
  initMetaPixel();
  trackMetaEvent('CompleteRegistration', {}, 'signup:test');
  assert.equal(scripts.length, 0);
  assert.equal(beacons.length, 0);
  assert.deepEqual(calls.map(([method, event]) => [method, event]), [
    ['init', '163428340971726'],
    ['track', 'PageView'],
    ['track', 'CompleteRegistration'],
  ]);
});
