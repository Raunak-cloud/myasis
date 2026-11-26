import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobBoardForUrl, isExternalApplicationUrl, nativeBoardPosting } from './job-board-url.js';

test('direct native job URLs resolve to exact board postings without accepting unrelated or unsafe pages', () => {
  const seek = {platform:'seek', id:'95237902', url:'https://www.seek.com.au/job/95237902'};
  assert.deepEqual(nativeBoardPosting('https://au.seek.com/job/95237902/apply?tracking=123'),seek);
  assert.deepEqual(nativeBoardPosting('https://www.seek.com.au/jobs?jobId=95237902'),seek);
  const indeed = {platform:'indeed', id:'0123456789abcdef', url:'https://au.indeed.com/viewjob?jk=0123456789abcdef'};
  assert.deepEqual(nativeBoardPosting('https://au.indeed.com/jobs?q=analyst&vjk=0123456789ABCDEF'),indeed);
  assert.deepEqual(nativeBoardPosting(indeed.url),indeed);
  for (const url of ['https://www.seek.com.au/jobs','https://au.indeed.com/jobs?q=x','http://au.indeed.com/viewjob?jk=0123456789abcdef',
    'https://www.seek.com.au:9001/job/95237902','https://test@www.seek.com.au/job/95237902','https://seek.com.au.other.test/job/95237902']) {
    assert.equal(nativeBoardPosting(url),null);
  }
});

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
