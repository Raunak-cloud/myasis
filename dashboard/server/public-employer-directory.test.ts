import assert from 'node:assert/strict';
import test from 'node:test';
import type { query } from './db/index.js';
import { expandedPublicEmployerSites } from './public-employer-directory.js';

for (const source of ['pageup', 'smartrecruiters'] as const) test(`${source}: all users reuse public roots from settings/history/index/search within the existing global allowance`, async () => {
  const sites = new Map<string, { target: string; label: string }>(), claims = new Set<string>(); let calls = 0, reservations = 0;
  const target = (n: number) => source === 'pageup' ? `https://careers.pageuppeople.com/${n}/cw/en` : `Employer${n}`;
  const url = (n: number) => source === 'pageup' ? `${target(n)}/job/123/analyst?token=fictional-private` : `https://jobs.smartrecruiters.com/${target(n)}/123-analyst?token=fictional-private`;
  const db = (async (sql: string, params: any[] = []) => {
    if (sql.includes('SELECT DISTINCT url,company')) return [{ url: url(2), company: 'Public Employer' }];
    if (sql.startsWith('SELECT DISTINCT value')) return [{ value: target(3) }];
    if (sql.startsWith('INSERT INTO public_employer_directory_searches')) { const key = params.join(':'); if (claims.has(key)) return []; claims.add(key); return [{ query: params[1] }]; }
    if (sql.startsWith('DELETE FROM public_employer_directory_searches')) { claims.delete(params.join(':')); return []; }
    if (sql.startsWith('INSERT INTO public_employer_directory(')) { sites.set(params[1], { target: params[2], label: params[3] }); return []; }
    if (sql.startsWith('SELECT target,label')) return [...sites.values()];
    throw Error(sql);
  }) as typeof query;
  const catalog = { key: 'fixture-only', reserveSearch: async () => { reservations++; return true; }, targets: async () => [target(4)] };
  const network: typeof fetch = async input => { calls++; const u = new URL(String(input)); assert.equal(u.searchParams.get('country'), 'au'); return Response.json({ web: { results: [{ url: url(5) }, { url: 'https://private.invalid/company' }] } }); };
  const options = { db, catalog, network, now: () => 0 };
  const first = await expandedPublicEmployerSites(source, target(1), 'Data Analyst', true, options);
  assert.equal(first.length, 5); assert.ok(first.every(item => !item.includes('token='))); assert.equal(calls, 2); assert.equal(reservations, 2);
  assert.equal((await expandedPublicEmployerSites(source, target(6), 'Data Analyst', true, options)).length, 6); assert.equal(calls, 2, 'the same daily queries are shared across users');
  await expandedPublicEmployerSites(source, target(1), 'Nurse', false, options); assert.equal(calls, 2, 'approved/targeted applications never launch discovery searches');
  const denied = { ...catalog, reserveSearch: async () => false };
  await expandedPublicEmployerSites(source, target(1), 'Engineer', true, { ...options, catalog: denied }); assert.equal(calls, 2, 'exhausted global allowance cannot issue requests');
  await expandedPublicEmployerSites(source, target(1), 'Engineer', true, options); assert.equal(calls, 3, 'a budget-denied claim is released for a later authorized query');
});

test('rotated empty pages fall back to page zero; failed searches can be retried without caching failure', async () => {
  let calls = 0, budget = 0; const claims = new Set<string>(), sites = new Map<string, any>();
  const db = (async (sql: string, p: any[] = []) => {
    if (sql.includes('SELECT DISTINCT')) return [];
    if (sql.startsWith('INSERT INTO public_employer_directory_searches')) { const k = p.join(':'); if (claims.has(k)) return []; claims.add(k); return [{}]; }
    if (sql.startsWith('DELETE FROM public_employer_directory_searches')) { claims.delete(p.join(':')); return []; }
    if (sql.startsWith('INSERT INTO public_employer_directory(')) { sites.set(p[1], { target: p[2], label: p[3] }); return []; }
    if (sql.startsWith('SELECT target,label')) return [...sites.values()];
    throw Error(sql);
  }) as typeof query;
  const catalog = { key: 'fixture-only', reserveSearch: async () => { budget++; return true; }, targets: async () => [] };
  const network: typeof fetch = async input => { calls++; return Response.json({ web: { results: new URL(String(input)).searchParams.get('offset') === '0' ? [{ url: 'https://careers.pageuppeople.com/841/cw/en/job/123/analyst' }] : [] } }); };
  assert.deepEqual(await expandedPublicEmployerSites('pageup', '', '', true, { db, catalog, network, now: () => 86400000 }), ['https://careers.pageuppeople.com/841/cw/en']); assert.equal(calls, 2); assert.equal(budget, 2);
  await expandedPublicEmployerSites('smartrecruiters', '', '', true, { db, catalog, network: async () => new Response('', { status: 503 }) });
  assert.ok(![...claims].some(key => key.startsWith('smartrecruiters:')));
});
