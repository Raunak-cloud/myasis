import { EMPLOYER_SOURCES } from '../../seek-bot/src/employer-source-config.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyJobSourceAccess, availableJobSources, jobSourceSettingsError } from './job-sources.js';
import { USER_SETTABLE_SETTINGS_KEYS } from './settings.js';

test('source access is validated independently of admin-only model and configuration access', () => {
  assert.equal(jobSourceSettingsError({ PLATFORMS: 'indeed, SmartRecruiters' }, false)?.status, 403);
  assert.equal(jobSourceSettingsError({ SMARTRECRUITERS_COMPANIES: 'Canva' }, false)?.status, 403);
  assert.equal(jobSourceSettingsError({ PLATFORMS: 'smartrecruiters', SMARTRECRUITERS_COMPANIES: 'Canva' }, true), null);
  assert.equal(jobSourceSettingsError({ SMARTRECRUITERS_COMPANIES: 'https://localhost' }, true)?.status, 400);
  assert.ok(!(USER_SETTABLE_SETTINGS_KEYS as readonly string[]).includes('SMARTRECRUITERS_ADMIN_ENABLED'));
  assert.ok(!(USER_SETTABLE_SETTINGS_KEYS as readonly string[]).includes('EMPLOYER_FEEDS_ADMIN_ENABLED'));
  for (const source of EMPLOYER_SOURCES) {
    assert.equal(jobSourceSettingsError({ PLATFORMS: source.id }, false)?.status, 403);
    assert.equal(jobSourceSettingsError({ [source.key]: source.defaults }, false)?.status, 403);
    assert.equal(jobSourceSettingsError({ PLATFORMS: source.id, [source.key]: source.defaults }, true), null);
  }
  for (const source of EMPLOYER_SOURCES) {
    assert.equal(jobSourceSettingsError({ PLATFORMS: source.id }, false, true), null);
    assert.equal(jobSourceSettingsError({ [source.key]: source.defaults }, false, true)?.status, 403);
  }
  assert.equal(jobSourceSettingsError({ APPLICATION_AI_MODEL: 'celeris' }, false, true)?.status, 403);

});

test('old saved settings and server environment cannot enable the feed on customer runs', () => {
  const settings = { PLATFORMS: 'seek,smartrecruiters', SMARTRECRUITERS_ADMIN_ENABLED: 'true', SMARTRECRUITERS_COMPANIES: 'Canva' };
  applyJobSourceAccess(settings, false);
  assert.equal(settings.PLATFORMS, 'seek');
  assert.equal(settings.SMARTRECRUITERS_ADMIN_ENABLED, 'false');
  for (const source of EMPLOYER_SOURCES) assert.equal((settings as Record<string, string>)[source.key], '');
  const only = { PLATFORMS: 'smartrecruiters' };
  applyJobSourceAccess(only, false);
  assert.equal(only.PLATFORMS, 'seek');
  const admin: Record<string, string> = { PLATFORMS: 'smartrecruiters' };
  applyJobSourceAccess(admin, true);
  assert.equal(admin.PLATFORMS, 'smartrecruiters');
  assert.equal(admin.SMARTRECRUITERS_ADMIN_ENABLED, 'true');
  assert.equal(admin.SMARTRECRUITERS_COMPANIES, 'Canva,KPMGAustralia1,Colliers');
});

test('admin feed-only runs need no SEEK or Indeed session and mixed runs retain signed-in boards', () => {
  assert.deepEqual(availableJobSources(['smartrecruiters'], true, () => false), {
    supported: ['smartrecruiters'], usable: ['smartrecruiters'], unavailable: [],
  });
  assert.deepEqual(availableJobSources(['seek', 'indeed', 'smartrecruiters'], true, board => board === 'seek'), {
    supported: ['seek', 'indeed', 'smartrecruiters'], usable: ['seek', 'smartrecruiters'], unavailable: ['indeed'],
  });
  assert.deepEqual(availableJobSources(['smartrecruiters', 'seek'], false, () => false), {
    supported: ['seek'], usable: [], unavailable: ['seek'],
  });
});

 test('all employer-only sources work for admins without a job-board session and remain disabled for customers', () => {
   const feeds = EMPLOYER_SOURCES.map(source => source.id);
   assert.deepEqual(availableJobSources(feeds, true, () => false), { supported: feeds, usable: feeds, unavailable: [] });
   assert.deepEqual(availableJobSources(feeds, false, () => false), { supported: [], usable: [], unavailable: [] });
   const settings: Record<string, string> = { PLATFORMS: feeds.join(','), EMPLOYER_FEEDS_ADMIN_ENABLED: 'true' };
   applyJobSourceAccess(settings, false); assert.equal(settings.PLATFORMS, 'seek'); assert.equal(settings.EMPLOYER_FEEDS_ADMIN_ENABLED, 'false');
 });

 test('Get Owtomated can use every employer source without a board session, with managed employer lists', () => {
   const feeds = EMPLOYER_SOURCES.map(source => source.id);
   assert.deepEqual(availableJobSources(feeds, true, () => false), { supported: feeds, usable: feeds, unavailable: [] });
   const settings: Record<string, string> = { PLATFORMS: feeds.join(','), SMARTRECRUITERS_COMPANIES: 'UntrustedOldOverride' };
   applyJobSourceAccess(settings, false, true);
   assert.equal(settings.PLATFORMS, feeds.join(','));
   assert.equal(settings.EMPLOYER_FEEDS_ADMIN_ENABLED, 'true');
   for (const source of EMPLOYER_SOURCES) assert.equal(settings[source.key], source.defaults);
   assert.equal(settings.APPLICATION_AI_MODEL, 'celeris');
   // Expiry rechecks actual access rather than trusting the old enabled flag.
   applyJobSourceAccess(settings, false, false);
   assert.equal(settings.PLATFORMS, 'seek');
   assert.equal(settings.EMPLOYER_FEEDS_ADMIN_ENABLED, 'false');
 });
