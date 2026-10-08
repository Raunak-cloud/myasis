import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile, expectedSalaryAnswer } from './config.js';

const directory = mkdtempSync(join(tmpdir(), 'profile-salary-'));
const file = join(directory, 'profile.txt');
try {
  writeFileSync(file, 'Name: Test Candidate\nExpected annual salary: \n');
  assert.equal(loadProfile(file).expectedSalary, 'Negotiable', 'a blank salary uses the approved fallback');
  writeFileSync(file, 'Name: Test Candidate\n');
  assert.equal(loadProfile(file).expectedSalary, 'Negotiable', 'an absent salary uses the same fallback');
  writeFileSync(file, 'Name: Test Candidate\nExpected annual salary: 150000\n');
  assert.equal(loadProfile(file).expectedSalary, '150000');
  assert.equal(expectedSalaryAnswer('   '), 'Negotiable');
  assert.equal(expectedSalaryAnswer(undefined), 'Negotiable');
  assert.equal(expectedSalaryAnswer(' 150000 '), '150000');
} finally {
  unlinkSync(file);
  rmdirSync(directory);
}
console.log('PASS: blank salary defaults to Negotiable; an explicit candidate figure is preserved');
