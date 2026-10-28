import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPLOYER_SOURCES, employerTargets, careerTarget } from '../../seek-bot/src/employer-source-config.js';
import { retiredJobSource, retiredJobDestination } from '../../seek-bot/src/retired-job-sources.js';
import { assertExternalJobUrl } from '../../seek-bot/src/external-url.js';
import { validateExternalJobUrl } from './external-job-url.js';
import { applyJobSourceAccess, jobSourceSettingsError } from './job-sources.js';

test('retired provider has no registry, UI source, adapter or settings path', () => {
  assert.deepEqual(EMPLOYER_SOURCES.map(source => source.id), ['smartrecruiters','greenhouse','pageup','workday']);
  assert.ok(jobSourceSettingsError({ PLATFORMS: 'lever' }, true));
  const saved = { PLATFORMS: 'seek,lever,workday', LEVER_COMPANIES: 'old', WORKDAY_SITES: 'HUB24|https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers' };
  applyJobSourceAccess(saved, true);
  assert.equal(saved.PLATFORMS, 'seek');
  assert.equal(Object.hasOwn(saved, 'LEVER_COMPANIES'), false);
  assert.equal(saved.WORKDAY_SITES, '');
});

test('remaining Workday employers still work and stale retired targets are removed', () => {
  const good = 'Nine|https://nine.wd105.myworkdayjobs.com/en-US/Nine_External_Career_Site';
  const removed = 'HUB24|https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers';
  assert.deepEqual(employerTargets('workday', `${removed},${good}`), [good]);
  assert.throws(() => careerTarget('workday', removed), /no longer available/);
  assert.ok(retiredJobSource({company:'HUB24 Limited',url:'https://www.seek.com.au/job/12345678'}));
  assert.ok(!retiredJobSource({company:'Nine',url:good.split('|')[1]}));
});

test('old direct links and employer handoffs are refused before DNS/network work', async () => {
  for (const url of ['https://jobs.lever.co/fixture/job/apply','https://api.lever.co/v0/postings/fixture','https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers/job/Sydney/Role_JR1']) {
    assert.ok(retiredJobDestination(url));
    const noNetwork = async () => { throw Error('Removed sources must not reach network resolution'); };
    await assert.rejects(assertExternalJobUrl(url, noNetwork), /no longer available/);
    assert.deepEqual(await validateExternalJobUrl(url, noNetwork), {error:'This job source is no longer available.'});
  }
  assert.ok(!retiredJobDestination('https://jobs.lever.co.example.invalid/apply'));
});
