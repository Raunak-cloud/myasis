import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmployerFeedDiscovery } from './employer-feeds.js';
import { workdayDirectoryTargets } from './workday-directory.js';

test('Workday resolves the verified server migration without modifying the supplied preference', async () => {
  const saved = 'Accenture|https://accenture.wd3.myworkdayjobs.com/en-US/AccentureCareers';
  const urls: string[] = [];
  const api = new EmployerFeedDiscovery('workday', saved, { gapMs: 0, fetch: async input => { urls.push(String(input)); return Response.json({ jobPostings: [], total: 0 }); } });
  await api.search('Data Analyst', 1);
  assert.match(urls[0], /^https:\/\/accenture\.wd103\.myworkdayjobs\.com\/wday\/cxs\/accenture\/AccentureCareers\/jobs$/);
  assert.equal(saved, 'Accenture|https://accenture.wd3.myworkdayjobs.com/en-US/AccentureCareers');
  assert.equal(workdayDirectoryTargets([saved, saved.replace('.wd3.', '.wd103.')]).length, 1);
});

test('Workday keeps cards whose location is only in configurable bullet fields, then reads their actual location', async () => {
  const api = new EmployerFeedDiscovery('workday', 'https://fixture.wd3.myworkdayjobs.com/en-US/Careers', { gapMs: 0, fetch: async input => Response.json(String(input).endsWith('/jobs') ? {
    total:2,jobPostings:[{title:'Data Analyst',externalPath:'/job/Sydney/Data-Analyst_R1',bulletFields:['R1','Location Negotiable']},{bulletFields:['R2','Sydney']}],
  } : {jobPostingInfo:{title:'Data Analyst',location:'Sydney',country:{descriptor:'Australia'},jobDescription:'Analyse Australian data'}}) });
  const jobs=await api.search('data',1);assert.equal(jobs.length,1);assert.equal(jobs[0].location,'Location not disclosed');
  assert.equal(jobs[0].teaser,'R1 · Location Negotiable');assert.equal((await api.detail(jobs[0])).location,'Sydney');
});

test('Workday tracks each employer/query pagination separately and keeps fresh detail reads', async () => {
  const calls: Array<{ host: string; keyword: string; offset: number }> = [];
  const api = new EmployerFeedDiscovery('workday', 'https://small.wd3.myworkdayjobs.com/en-US/Careers,https://large.wd3.myworkdayjobs.com/en-US/Careers', { gapMs: 0, fetch: async (input, init) => {
    const host = new URL(String(input)).hostname, q = JSON.parse(String(init?.body));calls.push({ host, keyword: q.searchText, offset: q.offset });
    return Response.json({ total: host.startsWith('small') ? 1 : 41, jobPostings: [{ title: 'Analyst', locationsText: 'Sydney', externalPath: '/job/Sydney/Analyst_R' + q.offset }] });
  } });
  await api.search('data', 1); await api.search('data', 2); await api.search('another keyword', 1);
  assert.equal(calls.filter(c => c.host.startsWith('small') && c.keyword === 'data').length, 1);
  assert.equal(calls.filter(c => c.host.startsWith('large') && c.keyword === 'data').length, 2);
  assert.ok(calls.some(c => c.host.startsWith('small') && c.keyword === 'another keyword'));
});

test('Workday no-Australia result stops only that keyword, not all future searches', async () => {
  let calls = 0;
  const api = new EmployerFeedDiscovery('workday', 'https://fixture.wd3.myworkdayjobs.com/en-US/Careers', { gapMs: 0, fetch: async () => {
    calls++;return Response.json({ jobPostings: [], facets: [{ descriptor: 'Country', facetParameter: 'country', values: [{ descriptor: 'Canada', id: 'ca' }] }] });
  } });
  await api.search('data', 1);await api.search('data', 2);assert.equal(calls, 1);
  await api.search('another keyword', 1);assert.equal(calls, 2);
});

test(`Workday endpoint failures cool down across instances while healthy employers continue`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owtomate-feed-health-'));let now = 10000000, bad = 0, good = 0;
  const targets = 'https://bad.wd3.myworkdayjobs.com/en-US/Careers,https://good.wd3.myworkdayjobs.com/en-US/Careers';
  const network: typeof fetch = async input => {
    if (/\/bad\./.test(String(input))) { bad++;return new Response('', { status: 404 }); }
    good++;return Response.json({ jobPostings: [] });
  };
  try {
    const options = { gapMs: 0, healthDirectory: dir, now: () => now, fetch: network };
    await new EmployerFeedDiscovery('workday', targets, options).search('data', 1);
    await new EmployerFeedDiscovery('workday', targets.split(',').map((url,i)=>`Label ${i}|${url.replace('/en-US/','/en-GB/')}`).join(','), options).search('reporting', 1);
    assert.equal(bad, 1);assert.equal(good, 2);
    now += 3600_001;await new EmployerFeedDiscovery('workday', targets, options).search('data', 1);
    assert.equal(bad, 2);assert.equal(good, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Workday respects a server retry delay without sleeping through the run or retrying every keyword', async () => {
  let now = 1000000, calls = 0;
  const api = new EmployerFeedDiscovery('workday', 'https://fixture.wd3.myworkdayjobs.com/en-US/Careers', { gapMs: 0, retryDelayMs: 0, now: () => now, fetch: async () => {
    calls++;return calls === 1 ? new Response('', { status: 503, headers: { 'Retry-After': '120' } }) : Response.json({ jobPostings: [] });
  } });
  await assert.rejects(api.search('data', 1), /None of the selected/);
  await assert.rejects(api.search('reporting', 1), /None of the selected/);assert.equal(calls, 1);
  now += 120001;await api.search('reporting', 1);assert.equal(calls, 2);
});
