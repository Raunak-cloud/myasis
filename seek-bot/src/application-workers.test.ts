import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationSlots, AsyncMutex } from './application-workers.js';

const limits = (extra = {}) => ({ run: 2, day: 10, external: 2, appliedToday: () => 0, externalToday: 0, ...extra });
test('two concurrent applications consume the shared run allowance; a third cannot overrun it', async () => {
  const slots = new ApplicationSlots(limits());
  const first = (await slots.acquire(false))!, second = (await slots.acquire(false))!;
  let answered = false;
  const third = slots.acquire(false).then(value => { answered = true; return value; });
  await Promise.resolve(); assert.equal(answered, false);
  first.finish(true); second.finish(true);
  assert.equal(await third, null);
});
test('a failed pre-send attempt releases capacity; finishing twice cannot double count', async () => {
  const slots = new ApplicationSlots(limits({ run: 1 }));
  const first = (await slots.acquire(false))!;
  const second = slots.acquire(false);
  first.finish(false); first.finish(true);
  const retry = await second; assert.ok(retry);
  retry.finish(true); assert.equal(await slots.acquire(false), null);
});
test('day allowance includes uncertain sends without double-counting newly persisted successes', async () => {
  let history = 4;
  const slots = new ApplicationSlots(limits({ day: 5, appliedToday: () => history }));
  const first = (await slots.acquire(false))!;
  const second = slots.acquire(false);
  history++; first.finish(true);
  assert.equal(await second, null);
});
test('late external redirects share one external allowance and never bypass it', async () => {
  const slots = new ApplicationSlots(limits({ external: 1 }));
  const first = (await slots.acquire(false))!, second = (await slots.acquire(false))!;
  assert.equal(first.beforeSubmit(true), true);
  assert.equal(second.beforeSubmit(true), false);
  first.finish(false);
  assert.equal(second.beforeSubmit(true), true);
  second.finish(true);
  assert.equal(await slots.acquire(true), null);
});
test('fallback discovery is serialized and one failed refill cannot poison its mutex', async () => {
  const mutex = new AsyncMutex(), seen: number[] = [];
  let active = 0, maximum = 0;
  const work = (id: number) => mutex.run(async () => {
    active++; maximum = Math.max(active, maximum);
    await new Promise(resolve => setTimeout(resolve, 5));
    seen.push(id); active--;
    if (id === 1) throw Error('offline fixture');
  });
  await Promise.allSettled([work(1), work(2), work(3)]);
  assert.equal(maximum, 1); assert.deepEqual(seen, [1, 2, 3]);
});
