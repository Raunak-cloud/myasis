import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'patchright';
import { browserDeadline, browserDelay, browserCleanup, BrowserOperationTimeout } from './browser-deadline.js';
import { hasCaptchaSurface, hasHcaptchaChallenge } from './captcha/detect.js';
import { readSavedForm } from './agent/saved-form.js';

test('a frozen renderer fails promptly instead of being reported as no security challenge', async () => {
  const frame = { url: () => 'https://fixture.invalid', parentFrame: () => null, evaluate: () => new Promise(() => {}) };
  const page = { frames: () => [frame], evaluate: frame.evaluate } as unknown as Page;
  for (const inspect of [hasHcaptchaChallenge, hasCaptchaSurface]) {
    await assert.rejects(browserDeadline('Fixture read', 30, () => inspect(page)), BrowserOperationTimeout);
  }
  await assert.rejects(browserDeadline('Fixture saved application', 30, () => readSavedForm(page)), BrowserOperationTimeout);
});

test('cancelled work cannot navigate or inject a token later; cleanup remains possible', async () => {
  let release!: () => void;
  let continued!: Promise<void>;
  let writes = 0, cleanups = 0;
  await assert.rejects(browserDeadline('Fixture solver', 30, () => {
    continued = (async () => {
      try {
        await new Promise<void>(resolve => { release = resolve; });
        await browserDeadline('Late token injection', 100, async () => { writes++; });
      } finally { await browserCleanup('Fixture cleanup', async () => { cleanups++; }); }
    })();
    return continued;
  }), BrowserOperationTimeout);
  release();
  await assert.rejects(continued, BrowserOperationTimeout);
  assert.equal(writes, 0);
  assert.equal(cleanups, 1);
});

test('ordinary nested work completes and a stalled child does not consume the entire parent budget', async () => {
  const value = await browserDeadline('Fixture parent', 1000, async () => {
    await assert.rejects(browserDeadline('Fixture child', 20, () => new Promise(() => {})), BrowserOperationTimeout);
    await browserDelay(1);
    return browserDeadline('Fixture recovery', 100, async () => 'recovered');
  });
  assert.equal(value, 'recovered');
  await delay(1);
});
