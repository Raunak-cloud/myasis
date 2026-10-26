import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getPool } from '../server/db/index.js';
import { insertApplicationRow } from '../server/db/records.js';
import { exportUserForRun, syncRunResultsToDb } from '../server/db/run-sync.js';
import { USERS_DIR, userDir } from '../server/userdata.js';

// Actual schema, insert, sync and next-run export; synthetic accounts only.
const schema = `duplicate_history_${randomUUID().replaceAll('-', '')}`;
const uid = String(800_000_000_000_000 + Math.floor(Math.random() * 100_000_000_000_000));
const otherUid = String(Number(uid) + 1);
const directories = [userDir(uid), userDir(otherUid)];
for (const dir of directories) assert.equal(existsSync(dir), false, 'never use an existing account directory');
const pool = getPool();
(pool as unknown as { options: { options: string } }).options.options = `-c search_path=${schema}`;
try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  const sql = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  await pool.query(sql); // migration is repeatable
  await pool.query('INSERT INTO users (id,email) VALUES ($1,$2),($3,$4)',
    [uid, 'duplicate-owner@example.invalid', otherUid, 'other-owner@example.invalid']);
  const applicationUrl = 'https://employer.fixture.invalid/jobs/shared-7?tenant=one';
  assert.equal(await insertApplicationRow(uid, { jobId: 'seek-7', title: 'Developer', company: 'Fixture', location: 'Sydney',
    platform: 'seek', url: 'https://www.seek.com.au/job/7', applicationUrl, score: 85 }), true);
  const exported = await exportUserForRun(uid);
  const appliedPath = resolve(exported.dir, 'applied.json');
  let history = JSON.parse(readFileSync(appliedPath, 'utf8'));
  assert.equal(history[0].applicationUrl, applicationUrl);
  const { reviewCurrentDuplicate } = await import(new URL('../../seek-bot/dist/duplicate-review.js', import.meta.url).href);
  const { withApplicationModel } = await import(new URL('../../seek-bot/dist/application-model.js', import.meta.url).href);
  const candidate = { id: 'indeed-7', title: 'Developer', company: 'Fixture', location: 'Sydney',
    platform: 'indeed', url: 'https://au.indeed.com/viewjob?jk=indeed-7', applicationUrl: applicationUrl + '&utm_source=indeed' };
  assert.equal(withApplicationModel({ DATA_DIR: exported.dir }, () => reviewCurrentDuplicate(candidate)).decision, 'duplicate');
  const foreign = await exportUserForRun(otherUid);
  assert.equal(withApplicationModel({ DATA_DIR: foreign.dir }, () => reviewCurrentDuplicate(candidate)).decision, 'clear');

  history.push({ jobId: 'new-posting', title: 'Engineer', company: 'Other Fixture', location: 'Sydney',
    url: 'https://www.seek.com.au/job/new-posting', applicationUrl: 'https://employer.fixture.invalid/jobs/new-posting',
    platform: 'seek', score: 85, appliedAt: new Date().toISOString(), submittedByMyasis: true });
  writeFileSync(appliedPath, JSON.stringify(history));
  await syncRunResultsToDb(uid, exported.dir);
  await exportUserForRun(uid);
  history = JSON.parse(readFileSync(appliedPath, 'utf8'));
  assert.equal(history.length, 2);
  assert.equal(history.find((record: { jobId: string }) => record.jobId === 'new-posting').applicationUrl, 'https://employer.fixture.invalid/jobs/new-posting');
  console.log('PASS: real database migration, application-destination persistence, next-run cross-board matching and owner isolation.');
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
  for (const dir of directories) {
    assert.equal(dirname(resolve(dir)), resolve(USERS_DIR));
    rmSync(dir, { recursive: true, force: true });
  }
}
