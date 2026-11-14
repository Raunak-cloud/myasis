import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import type { Page } from 'patchright';
import { browserDeadline, browserDelay, browserCleanup, BrowserOperationTimeout, browserOperationOptions, browserOperationTimeout, BROWSER_OPERATION_TIMEOUT_MS } from './browser-deadline.js';
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

test('external read cancellation preserves its typed cause, releases listeners and prevents late writes', async () => {
  const already = new AbortController(), cause = new Error('Fixture read cancelled'); already.abort(cause);
  let starts = 0;
  await assert.rejects(browserDeadline('Already cancelled',100,async()=>{starts++;},already.signal),error=>error===cause);
  assert.equal(starts,0); assert.equal(getEventListeners(already.signal,'abort').length,0);
  const controller = new AbortController();
  let release!:()=>void, continuation!:Promise<void>, writes=0;
  const running=browserDeadline('Externally cancelled read',1000,()=>{
    continuation=(async()=>{await new Promise<void>(done=>{release=done;});await browserDeadline('Late read mutation',100,async()=>{writes++;});})();
    return continuation;
  },controller.signal);
  await delay(1);controller.abort(cause);
  await assert.rejects(running,error=>error===cause); assert.equal(getEventListeners(controller.signal,'abort').length,0);
  release();await assert.rejects(continuation,error=>error===cause);assert.equal(writes,0);
  const successful=new AbortController();
  assert.equal(await browserDeadline('Independent next read',100,async()=>'next',successful.signal),'next');
  assert.equal(getEventListeners(successful.signal,'abort').length,0);
});

test('inner I/O inherits remaining time and cancellation without resetting its deadline', async () => {
  assert.deepEqual(browserOperationOptions(), {timeout:BROWSER_OPERATION_TIMEOUT_MS});
  let options!: ReturnType<typeof browserOperationOptions>;
  await browserDeadline('Owner',500,async()=>{
    options=browserOperationOptions();
    assert.ok(options.signal);
    await browserDelay(30);
    const next=browserOperationOptions();
    assert.equal(next.signal,options.signal);
    assert.ok(next.timeout<options.timeout);
    assert.ok(next.timeout>0);
    assert.ok(browserOperationTimeout(10)<=10,'explicit shorter condition waits remain bounded');
  });
  assert.equal(options.signal?.aborted,true,'detached native work is cancelled when its owner completes');
});

test('a slow security inspection can use its parent budget instead of failing at five seconds', {timeout:10000}, async()=>{
  const frame={url:()=> 'https://fixture.invalid',parentFrame:()=>null,evaluate:async()=>{await delay(5500);return false;}};
  const page={frames:()=>[frame],evaluate:frame.evaluate} as unknown as Page;
  assert.equal(await browserDeadline('Slow but responsive inspection',8000,()=>hasHcaptchaChallenge(page)),false);
});
