import assert from 'node:assert/strict';
import test from 'node:test';
import { SitePacer } from './pacing.js';

/** A clock that only moves when the pacer sleeps or a "request" takes time. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleep: async (ms: number) => { slept.push(ms); t += ms; },
    slept,
  };
}

test('a site waits only for what is left of its own gap', async () => {
  const clock = fakeClock();
  const pacer = new SitePacer(clock.now, clock.sleep, () => 0);
  assert.equal(await pacer.ready('seek'), 0, 'the first request goes straight away');
  clock.advance(3_000); // the SEEK search
  pacer.done('seek', 6_000, 10_000);
  assert.equal(await pacer.ready('indeed'), 0, 'Indeed does not wait out SEEK\'s gap');
  clock.advance(4_000); // the Indeed search
  pacer.done('indeed', 6_000, 10_000);
  assert.equal(await pacer.ready('seek'), 2_000, 'SEEK waits only the 2 s left of its 6 s gap');
});

test('each site still sees its full gap between requests', async () => {
  const clock = fakeClock();
  const pacer = new SitePacer(clock.now, clock.sleep, () => 0.5);
  const finished: number[] = [];
  for (let i = 0; i < 4; i++) {
    await pacer.ready('seek');
    if (finished.length) assert.ok(clock.now() - finished.at(-1)! >= 8_000, 'never closer than the gap');
    clock.advance(1_000);
    finished.push(clock.now());
    pacer.done('seek', 6_000, 10_000);
  }
  assert.deepEqual(clock.slept, [8_000, 8_000, 8_000], 'one board alone waits as it did before');
});

test('the gap stays randomized within its range', () => {
  const clock = fakeClock();
  for (const [r, expected] of [[0, 6_000], [0.999, 10_795]] as const) {
    const pacer = new SitePacer(clock.now, clock.sleep, () => r);
    pacer.done('seek', 6_000, 10_800);
    assert.equal((pacer as unknown as { readyAt: Map<string, number> }).readyAt.get('seek'), expected);
  }
});
