import assert from 'node:assert/strict';
import test from 'node:test';
import type { query } from './db/index.js';
import { expandedPublicEmployerSites } from './public-employer-directory.js';

test('Greenhouse reuses known boards from settings, history and the index', async () => {
  const boards = new Map<string, string>();
  const db = (async (sql: string, params: string[] = []) => {
    if (sql.includes('SELECT DISTINCT url,company')) return [
      { url: 'https://job-boards.greenhouse.io/history/jobs/123?token=fixture', company: 'History' },
      { url: 'https://jobs.smartrecruiters.com/retired/123', company: 'Retired' },
    ];
    if (sql.startsWith('SELECT DISTINCT value')) return [{ value: 'saved,Known' }];
    if (sql.startsWith('INSERT INTO public_employer_directory(')) { boards.set(params[0], params[1]); return []; }
    if (sql.startsWith('SELECT target FROM')) return [...boards.values()].map(target => ({ target }));
    throw Error(sql);
  }) as typeof query;
  const catalog = { targets: async () => ['indexed', 'https://boards.greenhouse.io/known/jobs/123'] };
  const first = await expandedPublicEmployerSites('configured', { db, catalog });
  assert.deepEqual(new Set(first.map(board => board.toLowerCase())), new Set(['configured', 'saved', 'known', 'history', 'indexed']));
  assert.equal(first.length, 5);
  const unavailable = { targets: async () => { throw Error('Index unavailable'); } };
  assert.deepEqual(new Set((await expandedPublicEmployerSites('configured', { db, catalog: unavailable })).map(board => board.toLowerCase())), new Set(first.map(board => board.toLowerCase())));
});
