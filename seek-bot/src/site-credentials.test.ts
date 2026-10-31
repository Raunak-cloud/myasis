import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplicationAction } from './types.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-credential-fixture-'));
const before = process.env.DATA_DIR;
process.env.DATA_DIR = directory;
const { commitAcceptedCredentials, storedCredential } = await import('./site-credentials.js');
const email = 'candidate@fixture.invalid';
const credential = { format: 'readable-v1' as const, rules: { max_length: 16 } };
const pending = new Map([['employer.fixture.invalid', credential]]);
const action = (kind: ApplicationAction['kind'], owner = email): ApplicationAction => ({ kind, site: 'www.employer.fixture.invalid', email: owner, detail: 'Fixture acceptance', at: new Date().toISOString() });
try {
  commitAcceptedCredentials(pending, [action('authentication-prepared')], email);
  assert.equal(storedCredential('https://employer.fixture.invalid', email), null, 'field preparation does not persist credentials');
  commitAcceptedCredentials(pending, [action('password-reset', 'other@fixture.invalid')], email);
  assert.equal(storedCredential('https://employer.fixture.invalid', email), null, 'another candidate acceptance cannot authorize this credential');
  commitAcceptedCredentials(pending, [action('password-reset')], email);
  assert.deepEqual(storedCredential('https://employer.fixture.invalid', email)?.rules, credential.rules, 'an explicitly accepted reset persists with canonical host identity');
  assert.equal(pending.size, 0, 'accepted proposals are retired so later acceptance cannot recommit them');
  assert.equal(storedCredential('https://different.fixture.invalid', email), null);
  console.log('PASS: credential preparation, explicit password-reset acceptance, canonical hosts and candidate isolation.');
} finally {
  rmSync(directory, { recursive: true, force: true });
  if (before === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = before;
}
