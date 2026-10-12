import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyJobSourceAccess, availableJobSources, jobSourceSettingsError } from './job-sources.js';
import { USER_SETTABLE_SETTINGS_KEYS } from './settings.js';
import { getPool } from './db/index.js';
import { startRun } from './start-run.js';

test('customer settings and every run trigger refuse SmartRecruiters before any database or browser action', async () => {
  assert.equal(jobSourceSettingsError({ PLATFORMS: 'indeed, SmartRecruiters' }, false)?.status, 403);
  assert.equal(jobSourceSettingsError({ SMARTRECRUITERS_COMPANIES: 'Canva' }, false)?.status, 403);
  assert.equal(jobSourceSettingsError({ PLATFORMS: 'smartrecruiters', SMARTRECRUITERS_COMPANIES: 'Canva' }, true), null);
  assert.equal(jobSourceSettingsError({ SMARTRECRUITERS_COMPANIES: 'https://localhost' }, true)?.status, 400);
  assert.ok(!(USER_SETTABLE_SETTINGS_KEYS as readonly string[]).includes('SMARTRECRUITERS_ADMIN_ENABLED'));
  const pool = getPool();
  const original = pool.query;
  pool.query = (async () => { throw new Error('Unauthorised source reached database'); }) as typeof original;
  try {
    for (const trigger of ['manual', 'auto', 'admin', 'onboarding'] as const) {
      for (const mode of ['search', 'live'] as const) {
        const result = await startRun({ userId: 'source-test', email: 'source-customer@example.test', mode, trigger,
          clientOverrides: { PLATFORMS: 'smartrecruiters', SMARTRECRUITERS_ADMIN_ENABLED: 'true' } });
        assert.ok(!result.ok && result.status === 403, `${trigger}/${mode}`);
      }
    }
  } finally { pool.query = original; await pool.end(); }
});

test('old saved settings and server environment cannot enable the feed on customer runs', () => {
  const settings = { PLATFORMS: 'seek,smartrecruiters', SMARTRECRUITERS_ADMIN_ENABLED: 'true', SMARTRECRUITERS_COMPANIES: 'Canva' };
  applyJobSourceAccess(settings, false);
  assert.deepEqual(settings, { PLATFORMS: 'seek', SMARTRECRUITERS_ADMIN_ENABLED: 'false', SMARTRECRUITERS_COMPANIES: '' });
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
