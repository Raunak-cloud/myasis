import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EMPTY_PROFILE } from './candidate-profile.js';
import { profileToLegacyText } from './db/run-sync.js';

test('Australian work rights retain their meaning through dashboard export and worker parsing', async () => {
  const { loadProfile } = await import(/* @vite-ignore */ new URL('../../seek-bot/dist/config.js', import.meta.url).href);
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-work-rights-'));
  const path = join(directory, 'profile.txt');
  try {
    for (const rights of ['Citizen', 'Permanent resident', 'Visa with limited work rights', '']) {
      writeFileSync(path, profileToLegacyText({ ...EMPTY_PROFILE, fullName: 'Fixture Candidate', workRights: rights }));
      const loaded = loadProfile(path);
      assert.equal(loaded.workRights, rights || undefined);
      assert.equal(loaded.workRightsCountry, rights ? 'Australia' : undefined);
      assert.equal(loaded.nationality, 'Not stated', 'work permission must not masquerade as nationality');
    }
    writeFileSync(path, 'Full name: Legacy Candidate\nNationality: Nepali\n');
    const legacy = loadProfile(path);
    assert.equal(legacy.nationality, 'Nepali');
    assert.equal(legacy.workRights, undefined, 'nationality alone never creates permission');
    writeFileSync(path, 'Work rights country: Canada\nWork rights: Citizen\n');
    const foreign = loadProfile(path);
    assert.equal(foreign.workRightsCountry, 'Canada');
    assert.equal(foreign.workRights, 'Citizen', 'the country key cannot be mistaken for the status');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
