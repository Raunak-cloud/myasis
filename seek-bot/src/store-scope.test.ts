import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { withApplicationModel } from './application-model.js';
import { AppliedIndex, logOutcome, recentReviewFeedback, saveRunSummary } from './store.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-store-scope-'));
const owners = ['one', 'two'].map(owner => {
  const dataDir = join(directory, owner);
  mkdirSync(dataDir);
  const facts = { ts: new Date().toISOString(), jobId: 'same-job', title: 'Fictional role', company: 'Fixture', status: 'skipped' };
  writeFileSync(join(dataDir, 'review-history.jsonl'), JSON.stringify({ ...facts, reason: 'history-' + owner }) + '\n');
  writeFileSync(join(dataDir, 'run-log.jsonl'), JSON.stringify({ ...facts, reason: 'private-feedback-' + owner }) + '\n');
  writeFileSync(join(dataDir, 'applied.json'), '[]');
  return { ...process.env, DATA_DIR: dataDir, COST_TRACKING: 'false' };
});
after(() => {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-store-scope-'));
  rmSync(directory, { recursive: true, force: true });
});

test('concurrent feedback reads never mix another account outcome into scoped history', async () => {
  const results = await Promise.all(owners.map((environment, index) => withApplicationModel(environment, async () => {
    await new Promise(done => setTimeout(done, index ? 1 : 5));
    const entries = [...recentReviewFeedback().values()];
    assert.equal(entries.length, 1);
    return entries[0].reason;
  })));
  assert.deepEqual(results, ['private-feedback-one', 'private-feedback-two']);
});

test('an application index retains its original owner when used inside another scope', () => {
  const first = withApplicationModel(owners[0], () => new AppliedIndex());
  withApplicationModel(owners[1], () => first.add({ jobId: 'first-only', title: 'Fictional role', company: 'Fixture',
    location: 'Fixture', url: 'https://fixture.invalid', appliedAt: new Date().toISOString(), score: 0,
    platform: 'seek', submittedByMyasis: false }));
  assert.equal(JSON.parse(readFileSync(join(owners[0].DATA_DIR, 'applied.json'), 'utf8')).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(owners[1].DATA_DIR, 'applied.json'), 'utf8')), []);
});

test('outcome and summary writes resolve the active account rather than module import state', async () => {
  await Promise.all(owners.map((environment, index) => withApplicationModel(environment, async () => {
    await Promise.resolve();
    logOutcome({ status: 'skipped', jobId: 'owner-' + index, reason: 'Fictional reason' });
    saveRunSummary(index + 1);
  })));
  for (let index = 0; index < owners.length; index++) {
    const lines = readFileSync(join(owners[index].DATA_DIR, 'run-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.at(-1).jobId, 'owner-' + index);
    const summary = JSON.parse(readFileSync(join(owners[index].DATA_DIR, 'run-summary.json'), 'utf8'));
    assert.equal(summary.qualifyingJobs, index + 1);
  }
});
