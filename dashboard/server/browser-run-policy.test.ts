import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserRunEnvironment } from './browser-run-policy.js';
import { accountBrowserEnvironment } from './runner.js';
import { getPool } from './db/index.js';

test('pilot is limited to admin-owned searches, including when operators run customer accounts', () => {
  for (const enabled of [undefined, 'false', 'true', '1']) {
    for (const admin of [false, true]) {
      for (const mode of ['search', 'live'] as const) {
        const env = { HEADLESS: 'true', BROWSER_CONNECT_CDP: 'true', ...browserRunEnvironment(admin, mode, enabled) };
        assert.equal(env.HEADLESS, String(admin && mode === 'search' && enabled === 'true'));
        assert.equal(env.BROWSER_CONNECT_CDP, 'false');
      }
    }
  }
});

test('worker policy resolves the owner from the database and fails closed for missing/blocked owners', async () => {
  const pool = getPool(), originalQuery = pool.query;
  const oldPilot = process.env.ADMIN_HEADLESS, oldAdmins = process.env.ADMIN_EMAILS;
  process.env.ADMIN_HEADLESS = 'true';
  process.env.ADMIN_EMAILS = 'operator@example.test';
  try {
    for (const owner of [{ email: 'operator@example.test' }, { email: 'customer@example.test' }, undefined]) {
      pool.query = (async (sql: string, params: unknown[]) => {
        assert.match(sql, /blocked_at IS NULL/);
        assert.deepEqual(params, ['owner-account']);
        return { rows: owner ? [owner] : [] };
      }) as typeof originalQuery;
      assert.equal((await accountBrowserEnvironment('owner-account', 'search')).HEADLESS, String(owner?.email === 'operator@example.test'));
      assert.equal((await accountBrowserEnvironment('owner-account', 'live')).HEADLESS, 'false');
    }
  } finally {
    pool.query = originalQuery;
    if (oldPilot === undefined) delete process.env.ADMIN_HEADLESS; else process.env.ADMIN_HEADLESS = oldPilot;
    if (oldAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = oldAdmins;
    await pool.end();
  }
});
