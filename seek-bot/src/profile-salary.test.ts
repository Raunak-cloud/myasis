import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile } from './config.js';

const directory = mkdtempSync(join(tmpdir(), 'profile-salary-'));
const file = join(directory, 'profile.txt');
try {
  writeFileSync(file, 'Name: Test Candidate\nExpected annual salary: \n');
  assert.equal(loadProfile(file).expectedSalary, '', 'a blank salary must not become Negotiable');
  writeFileSync(file, 'Name: Test Candidate\n');
  assert.equal(loadProfile(file).expectedSalary, '', 'an absent salary stays unknown');
  writeFileSync(file, 'Name: Test Candidate\nExpected annual salary: 150000\n');
  assert.equal(loadProfile(file).expectedSalary, '150000');
} finally {
  unlinkSync(file);
  rmdirSync(directory);
}
console.log('PASS: missing salary remains unknown; an explicit candidate figure is preserved');
