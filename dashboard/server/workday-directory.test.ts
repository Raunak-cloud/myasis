import assert from 'node:assert/strict';
import test from 'node:test';
import type { query } from './db/index.js';
import { expandedWorkdaySites, workdayCandidates } from './workday-directory.js';

test('Workday reuses configured, historical and indexed career sites without retaining application data', async () => {
  const sites = new Map<string, string>();
  const root = (tenant: string) => `https://${tenant}.wd1.myworkdayjobs.com/en-US/Careers`;
  const db = (async (sql: string, params: string[] = []) => {
    if (sql.includes('SELECT DISTINCT url,company')) return [{ url: root('history') + '/job/Sydney/Role_R2/apply?token=fixture', company: 'History Employer' }];
    if (sql.startsWith('INSERT INTO workday_directory(')) { sites.set(params[0], params[1] || sites.get(params[0]) || ''); return []; }
    if (sql.startsWith('SELECT site,label')) return [...sites].map(([site, label]) => ({ site, label }));
    throw Error(sql);
  }) as typeof query;
  const catalog = { targets: async () => [root('indexed'), 'https://private.invalid/en-US/Jobs'] };
  assert.deepEqual(await expandedWorkdaySites('Saved|' + root('saved'), { db, catalog }), [
    'Saved|' + root('saved'), 'History Employer|' + root('history'), root('indexed'),
  ]);
  const unavailable = { targets: async () => { throw Error('Index unavailable'); } };
  assert.equal((await expandedWorkdaySites(root('new'), { db, catalog: unavailable })).length, 4);
  assert.deepEqual(workdayCandidates([{ url: 'https://invalid.example/jobs' }]), []);
});
