import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPLOYER_SOURCES, employerTargets, workdayCareerTarget } from '../../seek-bot/src/employer-source-config.js';
import { retiredDiscoveryPlatform } from '../../seek-bot/src/retired-job-sources.js';
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
  assert.equal(saved.PLATFORMS, 'seek,workday');
  for (const key of ['LEVER_COMPANIES', 'SMARTRECRUITERS_COMPANIES', 'SMARTRECRUITERS_ADMIN_ENABLED', 'PAGEUP_SITES']) assert.equal(Object.hasOwn(saved, key), false);
  assert.equal(saved.WORKDAY_SITES, 'HUB24|https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers');
});

test('all valid Workday employer roots survive selection', () => {
  const good = 'Nine|https://nine.wd105.myworkdayjobs.com/en-US/Nine_External_Career_Site';
  const hub = 'HUB24|https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers';
  assert.deepEqual(employerTargets('workday', `${hub},${good}`), [hub,good]);
  assert.equal(workdayCareerTarget(hub).url.hostname, 'hub24management.wd105.myworkdayjobs.com');
});

test('PageUp and SmartRecruiters are excluded from discovery and accepted as public application destinations', async () => {
  const resolvesPublic = async () => true;
  for (const [platform, url] of [
    ['smartrecruiters', 'https://jobs.smartrecruiters.com/fixture/1234'],
    ['pageup', 'https://secure.dc2.pageuppeople.com/apply/999'],
  ]) {
    assert.ok(retiredDiscoveryPlatform(platform));
    assert.equal(await validateExternalJobUrl(url, resolvesPublic), url);
    assert.equal(await assertExternalJobUrl(url, resolvesPublic), url);
    assert.equal(await assertExternalNavigationUrl(url, resolvesPublic), url);
    await assert.rejects(assertExternalNavigationUrl(url, async () => false), /public internet addresses/);
  }
});

test('Lever, HUB24 and previously unseen boards can receive public applications', async () => {
  for (const url of ['https://jobs.lever.co/fixture/job/apply','https://jobs.eu.lever.co/fixture/job/apply','https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers/job/Sydney/Role_JR1','https://new-board.example/apply/123']) {
    const publicHost = async (host: string) => host === new URL(url).hostname;
    assert.equal(await validateExternalJobUrl(url, publicHost), url);
    assert.equal(await assertExternalJobUrl(url, publicHost), url);
    assert.equal(await assertExternalNavigationUrl(url, publicHost), url);
    assert.deepEqual(await validateExternalJobUrl(url, async () => false), {error:'The external job URL must resolve only to public internet addresses.'});
  }
});
