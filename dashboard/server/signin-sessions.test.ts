import assert from 'node:assert/strict';
import test from 'node:test';
import { SigninSessions } from './signin-sessions.js';
import type { SigninDesktop } from './signin-desktop.js';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise, resolve}; };
function desktop(start = async () => {}, stop = async () => {}) {
  const fake = { state: 'starting', revision: 0, display: 100, vncPort: 5900, message: '',
    start: async () => { await start(); fake.state = 'ready'; fake.revision++; },
    stop: async () => { fake.state = 'closed'; await stop(); },
  };
  return fake as unknown as SigninDesktop;
}

test('simultaneous opens share one launch; the account is reserved throughout preparation', async () => {
  const gate = deferred(); let preparations = 0;
  const sessions = new SigninSessions(async () => { preparations++; await gate.promise; return desktop(); });
  const first = sessions.start('A', 'seek'); const second = sessions.start('A', 'seek');
  assert.equal(sessions.count(), 1); assert.equal(sessions.sessionFor('A')?.state, 'starting');
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(preparations, 1); assert.equal(results[0].session?.id, results[1].session?.id);
  await sessions.stopAll();
});
test('closing during launch cancels it; a replacement waits for cleanup and ignores the old result', async () => {
  const gate = deferred(); const cleanup = deferred(); let preparations = 0;
  const sessions = new SigninSessions(async () => {
    preparations++;
    return preparations === 1 ? desktop(() => gate.promise, () => cleanup.promise) : desktop();
  });
  const first = sessions.start('A', 'seek');
  await new Promise(done => setImmediate(done));
  const oldId = sessions.sessionFor('A')!.id;
  const closing = sessions.stop('A'); const second = sessions.start('A', 'indeed');
  assert.notEqual(sessions.sessionFor('A')!.id, oldId);
  assert.equal(preparations, 1, 'new profile must not open during old cleanup');
  gate.resolve(); cleanup.resolve(); await closing;
  assert.equal((await first).ok, false); assert.equal((await second).ok, true);
  assert.equal(sessions.sessionFor('A')?.target, 'indeed');
  await sessions.stopAll();
});
test('failed preparation can be retried without retaining a launch or capacity slot', async () => {
  let preparations = 0;
  const sessions = new SigninSessions(async () => { if (++preparations === 1) throw new Error('Fixture startup failed'); return desktop(); });
  assert.equal((await sessions.start('A', 'seek')).ok, false); assert.equal(sessions.count(), 0);
  assert.equal((await sessions.start('A', 'seek')).ok, true);
  await sessions.stopAll();
});
test('opening Gmail replaces a job-board window only after its browser releases the profile', async () => {
  const cleanup = deferred(); const targets: string[] = [];
  const sessions = new SigninSessions(async session => {
    targets.push(session.target);
    return desktop(undefined, session.target === 'seek' ? () => cleanup.promise : undefined);
  });
  const first = await sessions.start('A', 'seek');
  const other = await sessions.start('B', 'indeed');
  const gmail = sessions.start('A', 'gmail', false);
  await new Promise(done => setImmediate(done));
  assert.deepEqual(targets, ['seek', 'indeed']);
  cleanup.resolve();
  const result = await gmail;
  assert.equal(result.ok, true); assert.equal(result.session?.target, 'gmail');
  assert.notEqual(result.session?.id, first.session?.id);
  assert.equal(sessions.sessionFor('B')?.id, other.session?.id, 'another account is unaffected');
  await sessions.stopAll();
});
test('recovery revisions keep the same profile session and original expiry; failed desktops can be replaced', async () => {
  let current = desktop();
  const sessions = new SigninSessions(async () => current);
  const initial = (await sessions.start('A', 'seek')).session!;
  current.state = 'recovering'; current.revision++;
  const snapshot = sessions.sessionFor('A')!;
  assert.equal(snapshot.id, initial.id); assert.equal(snapshot.expiresAt, initial.expiresAt); assert.equal(snapshot.state, 'recovering');
  current.state = 'failed'; const old = current; current = desktop();
  const replacement = await sessions.start('A', 'seek');
  assert.equal(old.state, 'closed'); assert.equal(replacement.ok, true); assert.notEqual(replacement.session?.id, initial.id);
  await sessions.stopAll();
});
test('expiry and shutdown cancel pending launches without reopening them', async () => {
  const gate = deferred(); let starts = 0;
  const sessions = new SigninSessions(async () => { await gate.promise; return desktop(async () => { starts++; }); }, 20);
  const opening = sessions.start('A', 'seek');
  await new Promise(done => setTimeout(done, 40));
  assert.equal(sessions.sessionFor('A')?.state, 'closed', 'the profile remains reserved until teardown finishes');
  gate.resolve(); assert.equal((await opening).ok, false); await sessions.stopAll(); assert.equal(starts, 0);
  assert.equal(sessions.sessionFor('A'), null);
});
test('restoring after a server restart respects the original deadline and caps supplied lifetimes', async () => {
  const sessions = new SigninSessions(async () => desktop(), 1_000);
  const until = Date.now() + 500;
  const restored = await sessions.start('A', 'seek', false, until);
  assert.equal(restored.session?.expiresAt, until);
  await sessions.stopAll();
  assert.equal((await sessions.start('A', 'seek', false, Date.now() - 1)).ok, false);
  assert.equal((await sessions.start('A', 'seek', false, NaN)).ok, false);
  const capped = await sessions.start('A', 'seek', false, Date.now() + 100_000);
  assert.ok(capped.session!.expiresAt <= Date.now() + 1_000);
  await sessions.stopAll();
});
