import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobBoardForUrl, isExternalApplicationUrl } from './job-board-url.js';

test('board aliases share identity while lookalike domains, userinfo and URL text grant no board access', () => {
  for (const host of ['www.seek.com.au', 'seek.com.au', 'au.seek.com', 'www.seek.com', 'AU.SEEK.COM.']) {
    const url = `https://${host}/job/95237902/apply/review`;
    assert.equal(jobBoardForUrl(url), 'seek');
    assert.equal(isExternalApplicationUrl(url), false);
  }
  for (const host of ['www.indeed.com', 'au.indeed.com', 'smartapply.indeed.com']) {
    assert.equal(jobBoardForUrl(`https://${host}/viewjob?jk=fixture`), 'indeed');
    assert.equal(isExternalApplicationUrl(`https://${host}/apply`), false);
  }
  for (const url of ['https://seek.com.attacker.test/job/7', 'https://notseek.com/job/7', 'https://seek.com@attacker.test/job/7', 'https://attacker.test/?url=https://au.seek.com/job/7']) {
    assert.equal(jobBoardForUrl(url), null);
    assert.equal(isExternalApplicationUrl(url), true);
  }
  assert.equal(jobBoardForUrl('not a URL'), null);
  assert.equal(isExternalApplicationUrl('https://au.seek.com/apply/external/7'), true);
  assert.equal(isExternalApplicationUrl('https://au.seek.com/job/7/apply?next=/apply/external'), false);
});
