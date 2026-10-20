import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withApplicationModel } from '../application-model.js';
import { config } from '../config.js';
import type { JobListing } from '../types.js';
import { startAgentActivity, readAgentActivities } from './agent-activity.js';
import { applicationHistory } from './agent-only-evidence.js';

const directories: string[] = [];
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
function owner() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-activity-')); directories.push(dir);
  return { dir, env: { DATA_DIR: dir } };
}
const job: JobListing = { id: 'same-job', title: 'Synthetic role', company: 'Synthetic company', location: 'Sydney', platform: 'seek', url: 'https://jobs.example.invalid/application' };
type Record = { id: string; jobId: string; status: string; submitted?: boolean; outcome?: string; detail?: string; stale?: boolean };
const activities = () => readAgentActivities() as Record[];

test('parallel attempts at the same job stay visible, advisory and independent', () => {
  const account = owner();
  withApplicationModel(account.env, () => {
    const first = startAgentActivity(job), second = startAgentActivity(job);
    const current = activities();
    assert.equal(current.length, 2, 'activity never authorizes or vetoes another application');
    assert.equal(new Set(current.map(record => record.id)).size, 2);
    assert.ok(current.every(record => record.status === 'running' && record.jobId === job.id));
    first.update({ status: 'running', submitted: true, detail: 'Submit pressed; waiting for page evidence.' });
    let records = activities();
    assert.equal(records.filter(record => record.submitted === true).length, 1);
    assert.equal(records.filter(record => record.submitted === undefined).length, 1);
    assert.ok(applicationHistory().includes('"agentActivities":'));
    assert.ok(applicationHistory().includes('waiting for page evidence'));
    assert.match(applicationHistory(), /submitted=true.*not confirmed receipt/);
    first.update({ status: 'finished', submitted: false, outcome: 'validation-rejected', detail: 'Required referral source was blank. No receipt.' });
    first.close(); first.close();
    records = activities();
    assert.ok(records.some(record => record.status === 'finished' && record.outcome === 'validation-rejected' && record.submitted === false));
    assert.ok(records.some(record => record.status === 'running'));
    first.update({ status: 'running' });
    assert.equal(activities().filter(record => record.status === 'running').length, 1, 'closed handles never reopen themselves');
    second.close();
    assert.ok(activities().some(record => record.status === 'interrupted'));
    assert.ok(readdirSync(join(account.dir, 'agent-activity')).every(name => name.endsWith('.json')), 'temporary files are removed after atomic rename');
  });
});

test('account activity remains scoped even if an existing handle is updated in another account context', () => {
  const first = owner(), second = owner();
  const handle = withApplicationModel(first.env, () => startAgentActivity(job));
  withApplicationModel(second.env, () => {
    assert.deepEqual(activities(), []);
    handle.update({ status: 'finished', submitted: true, outcome: 'applied', detail: 'Parent observed a receipt.' });
    assert.deepEqual(activities(), []);
    const other = startAgentActivity({ ...job, id: 'other-owner-job' }); other.close();
  });
  withApplicationModel(first.env, () => {
    assert.equal(activities().length, 1);
    assert.equal(activities()[0].outcome, 'applied');
    assert.ok(!applicationHistory().includes('other-owner-job'));
  });
  withApplicationModel(second.env, () => assert.equal(activities()[0].jobId, 'other-owner-job'));
  handle.close();
});

test('stale running records are labelled interrupted without rewriting their evidence', () => {
  const account = owner();
  withApplicationModel(account.env, () => {
    const handle = startAgentActivity(job);
    const folder = join(account.dir, 'agent-activity'), file = join(folder, readdirSync(folder)[0]);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record.startedAt = new Date(Date.now() - config.celeris.maxTotalMs - 301_000).toISOString();
    record.updatedAt = record.startedAt;
    record.submitted = true; record.detail = 'The submit result was not observed.';
    writeFileSync(file, JSON.stringify(record));
    const before = readFileSync(file);
    const current = activities()[0];
    assert.equal(current.status, 'interrupted');
    assert.equal(current.stale, true);
    assert.equal(current.submitted, true);
    assert.match(current.detail!, /not observed/);
    assert.deepEqual(readFileSync(file), before, 'reader does not retire or confirm an attempt in storage');
    handle.close();
  });
});

test('retention keeps 500 recent terminal records and every running record', () => {
  const account = owner(), folder = join(account.dir, 'agent-activity'); mkdirSync(folder);
  const oldestId = randomUUID();
  for (let index = 0; index < 505; index++) {
    const id = index === 0 ? oldestId : randomUUID();
    writeFileSync(join(folder, id + '.json'), JSON.stringify({ id, jobId: `finished-${index}`, status: index % 2 ? 'finished' : 'interrupted',
      startedAt: new Date(2020, 0, 1, 0, index).toISOString(), updatedAt: new Date(2020, 0, 1, 0, index).toISOString() }));
  }
  withApplicationModel(account.env, () => {
    const one = startAgentActivity(job), two = startAgentActivity({ ...job, id: 'another-running' });
    one.update({ status: 'finished', outcome: 'skipped' });
    const current = activities();
    assert.equal(current.filter(record => record.status === 'running').length, 1);
    assert.equal(current.filter(record => record.status !== 'running').length, 500);
    assert.equal(existsSync(join(folder, oldestId + '.json')), false);
    assert.equal(readdirSync(folder).length, 501);
    one.close(); two.close();
    assert.equal(readdirSync(folder).length, 500);
  });
});

test('activity never changes reservation, applied or claim records', () => {
  const account = owner();
  const names = ['application-reservations.sqlite', 'applied.json', 'claims.json'];
  for (const name of names) writeFileSync(join(account.dir, name), `UNCHANGED ${name}`);
  const before = names.map(name => readFileSync(join(account.dir, name)));
  withApplicationModel(account.env, () => {
    const handle = startAgentActivity(job);
    handle.update({ status: 'running', submitted: true });
    handle.update({ status: 'finished', outcome: 'uncertain' });
    readAgentActivities(); handle.close();
  });
  names.forEach((name, index) => assert.deepEqual(readFileSync(join(account.dir, name)), before[index]));
});

test('symlinked activity directories cannot leak or change another account and failure never vetoes', () => {
  const account = owner(), foreign = owner(), outside = join(foreign.dir, 'external-activities'); mkdirSync(outside);
  writeFileSync(join(outside, 'do-not-change.txt'), 'FOREIGN_PRIVATE_DATA');
  symlinkSync(outside, join(account.dir, 'agent-activity'), process.platform === 'win32' ? 'junction' : 'dir');
  withApplicationModel(account.env, () => {
    assert.deepEqual(activities(), []);
    assert.doesNotThrow(() => { const handle = startAgentActivity(job); handle.update({ status: 'running', submitted: true }); handle.close(); });
    assert.deepEqual(activities(), []);
  });
  assert.deepEqual(readdirSync(outside), ['do-not-change.txt']);
  assert.equal(readFileSync(join(outside, 'do-not-change.txt'), 'utf8'), 'FOREIGN_PRIVATE_DATA');
});

test('reader ignores malformed and oversized files and returns a bounded recent set', () => {
  const account = owner(), folder = join(account.dir, 'agent-activity'); mkdirSync(folder);
  writeFileSync(join(folder, randomUUID() + '.json'), '{bad');
  writeFileSync(join(folder, randomUUID() + '.json'), 'x'.repeat(17_000));
  writeFileSync(join(folder, '../outside.json'), JSON.stringify({ status: 'running' }));
  for (let index = 0; index < 2005; index++) {
    const id = randomUUID();
    writeFileSync(join(folder, id + '.json'), JSON.stringify({ id, jobId: `live-${index}`, status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  }
  withApplicationModel(account.env, () => {
    assert.equal(activities().length, 2000);
    assert.ok(activities().every(record => record.jobId.startsWith('live-')));
  });
  assert.equal(readdirSync(folder).length, 2007, 'bounded reads never delete live advisory records');
});
