import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPLOYER_SOURCES, employerTargets, workdayCareerTarget } from '../../seek-bot/src/employer-source-config.js';
import { retiredEmployerFeed, retiredJobSource, retiredJobDestination } from '../../seek-bot/src/retired-job-sources.js';
import { assertExternalJobUrl, assertExternalNavigationUrl } from '../../seek-bot/src/external-url.js';
import { validateExternalJobUrl } from './external-job-url.js';
import { applyJobSourceAccess, jobSourceSettingsError } from './job-sources.js';
import { effectivePlatforms } from './entitlements.js';

test('retired provider has no registry, UI source, adapter or settings path', () => {
  assert.deepEqual(EMPLOYER_SOURCES.map(source => source.id), ['greenhouse','workday']);
  for (const source of ['lever', 'smartrecruiters', 'pageup', 'web-search']) {
    assert.equal(jobSourceSettingsError({ PLATFORMS: source }, true)?.status, 400);
  }
  const saved = { PLATFORMS: 'seek,lever,smartrecruiters,pageup,workday,web-search', LEVER_COMPANIES: 'old', SMARTRECRUITERS_COMPANIES: 'old', SMARTRECRUITERS_ADMIN_ENABLED: 'true', PAGEUP_SITES: 'old', WORKDAY_SITES: 'HUB24|https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers' };
  assert.equal(effectivePlatforms(saved, {indeedApplications:false, employerSources:false}), 'seek');
  applyJobSourceAccess(saved, true);
  assert.equal(saved.PLATFORMS, 'seek');
  for (const key of ['LEVER_COMPANIES', 'SMARTRECRUITERS_COMPANIES', 'SMARTRECRUITERS_ADMIN_ENABLED', 'PAGEUP_SITES']) assert.equal(Object.hasOwn(saved, key), false);
  assert.equal(saved.WORKDAY_SITES, '');
});

test('remaining Workday employers still work and stale retired targets are removed', () => {
  const good = 'Nine|https://nine.wd105.myworkdayjobs.com/en-US/Nine_External_Career_Site';
  const removed = 'HUB24|https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers';
  assert.deepEqual(employerTargets('workday', `${removed},${good}`), [good]);
  assert.throws(() => workdayCareerTarget(removed), /no longer available/);
  assert.ok(retiredJobSource({company:'HUB24 Limited',url:'https://www.seek.com.au/job/12345678'}));
  assert.ok(!retiredJobSource({company:'Nine',url:good.split('|')[1]}));
});

test('PageUp and SmartRecruiters are excluded from discovery and accepted as public application destinations', async () => {
  const resolvesPublic = async () => true;
  for (const [platform, url] of [
    ['smartrecruiters', 'https://jobs.smartrecruiters.com/fixture/1234'],
    ['pageup', 'https://secure.dc2.pageuppeople.com/apply/999'],
  ]) {
    assert.ok(retiredEmployerFeed({ platform }));
    assert.ok(retiredEmployerFeed({ url }));
    assert.ok(!retiredJobSource({ platform: 'seek', url: 'https://www.seek.com.au/job/12345678', applicationUrl: url }));
    assert.ok(!retiredJobDestination(url));
    assert.equal(await validateExternalJobUrl(url, resolvesPublic), url);
    assert.equal(await assertExternalJobUrl(url, resolvesPublic), url);
    assert.equal(await assertExternalNavigationUrl(url, resolvesPublic), url);
    await assert.rejects(assertExternalNavigationUrl(url, async () => false), /public internet addresses/);
  }
});

test('separately removed Lever and HUB24 destinations are refused before DNS resolution', async () => {
  for (const url of ['https://jobs.lever.co/fixture/job/apply','https://api.lever.co/v0/postings/fixture','https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers/job/Sydney/Role_JR1']) {
    assert.ok(retiredJobDestination(url));
    const noNetwork = async () => { throw Error('Removed sources must not reach network resolution'); };
    await assert.rejects(assertExternalJobUrl(url, noNetwork), /no longer available/);
    assert.deepEqual(await validateExternalJobUrl(url, noNetwork), {error:'This job source is no longer available.'});
  }
  assert.ok(!retiredJobDestination('https://jobs.lever.co.example.invalid/apply'));
});
