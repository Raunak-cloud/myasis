import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.MAX_CONCURRENT_RUNS = '3';
const { RunPool, MAX_CONCURRENT } = await import('./runner.js');
assert.equal(MAX_CONCURRENT, 3);

/** Replace only the process boundary: exercise actual pool admission while
 * holding account preparation open, without launching Chrome or contacting DB. */
function fixture() {
  const pool = new RunPool();
  const runs = Reflect.get(pool, 'runs') as Map<string, unknown>;
  const releases: Array<() => void> = [];
  const ports: number[] = [];
  const fake = () => ({
    occupiesSlot: false, disposable: false, browserPort: null as number | null, workerSlots: 1,
    async start(_mode: unknown, _settings: unknown, port: number, _submit: unknown, _finished: unknown, _start: unknown, _keywords: unknown, expand: () => boolean) {
      this.browserPort = port; ports.push(port);
      await new Promise<void>(resolve => releases.push(resolve));
      this.workerSlots = expand() ? 2 : 1;
      this.occupiesSlot = true;
      return { ok: true };
    },
    async startQueue() { return { ok: false, error: 'A run is already in progress.' }; },
  });
  const accounts = ['one', 'two', 'three', 'four'].map(id => { const run = fake(); runs.set(id, run); return run; });
  return { pool, releases, ports, accounts };
}

test('simultaneous starts reserve capacity and distinct ports before account preparation awaits', async () => {
  const { pool, releases, ports } = fixture();
  const starts = ['one', 'two', 'three'].map(id => pool.start('live', {}, id));
  assert.equal(pool.activeCount(), 3);
  assert.equal(new Set(ports).size, 3);
  assert.equal((await pool.start('live', {}, 'four')).ok, false);
  assert.equal((await pool.start('live', {}, 'one')).ok, false);
  releases.forEach(release => release());
  assert.ok((await Promise.all(starts)).every(result => result.ok));
  assert.equal(pool.activeCount(), 3);
});

test('one parallel run plus one serial run respects the three-slot machine budget', async () => {
  const { pool, releases, accounts } = fixture();
  const first = pool.start('live', {}, 'one'), second = pool.start('live', {}, 'two');
  releases[0](); await first;
  releases[1](); await second;
  assert.deepEqual(accounts.slice(0, 2).map(run => run.workerSlots), [2, 1]);
  assert.equal(pool.activeCount(), 3);
  assert.equal((await pool.start('live', {}, 'three')).ok, false);
  assert.equal((await pool.startQueue('one')).ok, false);
  assert.equal(accounts[0].workerSlots, 2, 'a refused queue start cannot reduce an active parallel run allocation');
  assert.equal(pool.activeCount(), 3);
});
