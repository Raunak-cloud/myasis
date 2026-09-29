import assert from 'node:assert/strict';
import { test } from 'node:test';

async function setup(label, search = '') {
  globalThis.__REDDIT_PIXEL_ID__ = 'a2_test';
  globalThis.location = { protocol: 'https:', search };
  globalThis.window = {};
  const scripts = [];
  globalThis.document = {
    cookie: '',
    createElement: () => ({}),
    head: { appendChild: (script) => scripts.push(script) },
  };
  const module = await import(`../src/redditPixel.ts?${label}`);
  return { ...module, scripts, calls: () => window.rdt.callQueue };
}

test('a sign-up does not report a dashboard PageVisit', async () => {
  const { trackRedditEvent, scripts, calls } = await setup('signup');
  trackRedditEvent('SignUp', { conversionId: 'signup:test' });
  assert.equal(scripts.length, 1);
  assert.deepEqual(calls().map((call) => call[1]), ['a2_test', 'SignUp']);
  assert.deepEqual(calls()[1][2], { conversionId: 'signup:test' });
});

test('a public landing reports PageVisit once, even after a conversion', async () => {
  const { initRedditPixel, trackRedditEvent, calls } = await setup('landing');
  initRedditPixel();
  initRedditPixel();
  trackRedditEvent('Purchase', { conversionId: 'purchase:test' });
  assert.deepEqual(calls().map((call) => call[1]), ['a2_test', 'PageVisit', 'Purchase']);
});

test('landing after a conversion reports the visit without reloading the script', async () => {
  const { initRedditPixel, trackRedditEvent, scripts, calls } = await setup('signout');
  trackRedditEvent('SignUp', { conversionId: 'signup:test' });
  initRedditPixel();
  assert.equal(scripts.length, 1);
  assert.deepEqual(calls().map((call) => call[1]), ['a2_test', 'SignUp', 'PageVisit']);
});

test('click ID is retained without loading the pixel on a private page', async () => {
  const { captureRedditClickId, scripts } = await setup('click', '?rdt_cid=click-123');
  captureRedditClickId();
  assert.equal(scripts.length, 0);
  assert.match(document.cookie, /owtomate_rdt_cid=click-123/);
});
