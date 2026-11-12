import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicEmployerTarget, publicEmployerTargets } from './public-employer-directory.js';
import { publicEmployerSearchCache } from './public-employer-search-cache.js';
import { SmartRecruitersDiscovery } from './smartrecruiters.js';
import { EmployerFeedDiscovery } from './employer-feeds.js';

test('discovery retains only canonical public employer identities and strips private/tracking values', () => {
  assert.equal(publicEmployerTarget('pageup', 'https://careers.pageuppeople.com/841/cw/en/job/123/example?source=private#apply'), 'https://careers.pageuppeople.com/841/cw/en');
  assert.equal(publicEmployerTarget('smartrecruiters', 'https://jobs.smartrecruiters.com/Canva/123-example?email=private'), 'Canva');
  assert.equal(publicEmployerTarget('smartrecruiters', 'https://careers.smartrecruiters.com/Canva'), 'Canva');
  assert.equal(publicEmployerTarget('smartrecruiters', 'https://api.smartrecruiters.com/v1/companies/Canva/postings/123'), 'Canva');
  for (const bad of ['https://127.0.0.1/841/cw/en', 'http://careers.pageuppeople.com/841/cw/en', 'https://user:secret@careers.pageuppeople.com/841/cw/en', 'https://careers.pageuppeople.com.evil.invalid/841/cw/en', 'https://secure.dc2.pageuppeople.com/apply/841']) assert.equal(publicEmployerTarget('pageup', bad), null);
  for (const bad of ['https://jobs.smartrecruiters.com/login?token=secret', 'https://jobs.smartrecruiters.com.evil.invalid/Canva', 'https://api.smartrecruiters.com/v1/users/Canva', 'https://u:p@jobs.smartrecruiters.com/Canva/123']) assert.equal(publicEmployerTarget('smartrecruiters', bad), null);
  assert.deepEqual(publicEmployerTargets('pageup', ['University|https://careers.pageuppeople.com/841/cw/en', 'https://careers.pageuppeople.com/841/cw/en/job/123/example']), ['University|https://careers.pageuppeople.com/841/cw/en']);
  assert.deepEqual(publicEmployerTargets('smartrecruiters', ['Canva', 'canva', 'https://jobs.smartrecruiters.com/Canva/123']), ['Canva']);
});

test('SmartRecruiters searches beyond 20 manual companies, keeps Australian/public filtering, paging and live details', async () => {
  let calls = 0; const requests: URL[] = [];
  const network: typeof fetch = async input => {
    const url = new URL(String(input)); requests.push(url); calls++;
    const company = url.pathname.split('/')[3];
    const posting = { id: '123', name: 'Data Analyst', location: { country: 'au', city: 'Sydney' }, active: true, visibility: 'PUBLIC', company: { identifier: company, name: company }, jobAd: { sections: { jobDescription: { text: '<p>Build reports</p>' } } } };
    return Response.json(url.pathname.endsWith('/123') ? posting : { content: [posting, { ...posting, id: '456', location: { country: 'us' } }, { ...posting, id: '789', visibility: 'INTERNAL' }] });
  };
  const additionalTargets = Array.from({ length: 26 }, (_, n) => `Employer${n}`);
  const api = new SmartRecruitersDiscovery('Canva', { additionalTargets, fetch: network, gapMs: 0, maxAgeDays: 10 });
  const jobs = await api.search('Data Analyst', 2); assert.equal(jobs.length, 27); assert.equal(calls, 27);
  assert.ok(requests.every(url => url.searchParams.get('country') === 'au' && url.searchParams.get('offset') === '50' && url.searchParams.has('releasedAfter')));
  assert.equal((await api.detail(jobs.at(-1)!)).description, 'Build reports'); assert.equal(calls, 28);
  calls = 0;
  await new SmartRecruitersDiscovery('Canva', { additionalTargets, fetch: network, gapMs: 0, shouldStop: () => calls >= 3 }).search('', 1);
  assert.equal(calls, 3, 'the run deadline stops additional directory requests');
  assert.throws(() => new SmartRecruitersDiscovery(additionalTargets.join(',')), /1–20/, 'the manual-list contract remains unchanged');
});

test('PageUp searches additional discovered roots beyond 20 and retrieves their actual descriptions', async () => {
  let calls = 0;
  const api = new EmployerFeedDiscovery('pageup', 'First|https://careers.pageuppeople.com/1/cw/en', {
    additionalTargets: Array.from({ length: 26 }, (_, n) => `Employer ${n}|https://careers.pageuppeople.com/${n + 2}/cw/en`), gapMs: 0,
    fetch: async input => {
      calls++; const url = new URL(String(input)), root = url.pathname.split('/').slice(0, 4).join('/');
      return new Response(url.pathname.includes('/job/') ? '<main id="job-content"><h2>Data Analyst</h2><span class="job-externalJobNo">123</span><span class="location">Sydney</span><a class="apply-link">Apply</a><div id="job-details">Build Australian reports</div></main>'
        : `<div id="search-results-content"><table><tr><td><a class="job-link" href="${root}/job/123/analyst">Data Analyst</a></td><td class="location">Sydney</td></tr></table></div>`);
    },
  });
  const jobs = await api.search('Data Analyst', 1); assert.equal(jobs.length, 27); assert.equal(calls, 27);
  assert.equal((await api.detail(jobs.at(-1)!)).description, 'Build Australian reports'); assert.equal(calls, 28);
});

test('SmartRecruiters public-link case aliases share canonical job IDs and allow fresh detail reads', async () => {
  const posting={id:'123',name:'Analyst',company:{identifier:'MedHealth3',name:'MedHealth'},location:{country:'au',city:'Sydney'},active:true,visibility:'PUBLIC',postingUrl:'https://jobs.smartrecruiters.com/medhealth3/123-analyst',jobAd:{sections:{description:{text:'Employer description'}}}};
  const network:typeof fetch=async input=>Response.json(new URL(String(input)).pathname.endsWith('/123')?posting:{content:[posting]});
  const lower=new SmartRecruitersDiscovery('medhealth3',{fetch:network,gapMs:0}),canonical=new SmartRecruitersDiscovery('MedHealth3',{fetch:network,gapMs:0});
  const a=(await lower.search('',1))[0],b=(await canonical.search('',1))[0];assert.equal(a.id,b.id);assert.equal(a.url,'https://jobs.smartrecruiters.com/MedHealth3/123');
  assert.equal((await lower.detail(a)).description,'Employer description');
});

test('shared search cache reuses only public lists, expires, and bypasses details, authentication and provider errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-employer-cache-')); let calls = 0, now = 10000000;
  try {
    const network: typeof fetch = async input => { calls++; return new Response(String(input).includes('pageuppeople') ? '<div id="search-results-content"></div>' : JSON.stringify({ content: [] })); };
    const urls = ['https://api.smartrecruiters.com/v1/companies/Canva/postings?country=au&q=analyst', 'https://careers.pageuppeople.com/841/cw/en/search/?search-keyword=analyst&page=1'];
    for (const url of urls) {
      const before = calls;
      await publicEmployerSearchCache(dir, network, () => now)(url);
      await publicEmployerSearchCache(dir, network, () => now)(url); assert.equal(calls, before + 1);
      await publicEmployerSearchCache(dir, network, () => now)(url, { headers: { Authorization: 'fixture-only' } }); assert.equal(calls, before + 2);
      await publicEmployerSearchCache(dir, network, () => now)(url + '&page=2'); assert.equal(calls, before + 3);
      now += 31 * 60_000; await publicEmployerSearchCache(dir, network, () => now)(url); assert.equal(calls, before + 4);
    }
    const before = calls;
    for (let i = 0; i < 2; i++) await publicEmployerSearchCache(dir, network)('https://api.smartrecruiters.com/v1/companies/Canva/postings/123');
    assert.equal(calls, before + 2);
    let failures = 0; const fail = publicEmployerSearchCache(dir, async () => { failures++; return new Response('', { status: 429 }); });
    for (let i = 0; i < 2; i++) await fail(urls[0] + '&q=uncached'); assert.equal(failures, 2);
    const beforeCutoff=calls;
    const cache=publicEmployerSearchCache(dir,network,()=>now);
    await cache(urls[0]+'&releasedAfter=2026-11-01T09:00:01.000Z');
    await cache(urls[0]+'&releasedAfter=2026-11-01T09:10:01.000Z');assert.equal(calls,beforeCutoff+1,'small per-run cutoff differences do not defeat shared caching');
    await cache(urls[0]+'&releasedAfter=2026-11-02T09:10:01.000Z');assert.equal(calls,beforeCutoff+2,'different listing-age windows remain separate');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PageUp card layouts and same-board result redirects preserve paging, brand, active job identity and full description', async () => {
  const requests: URL[] = [];
  const api = new EmployerFeedDiscovery('pageup', 'https://careers.pageuppeople.com/434/caw/en', { gapMs: 0, fetch: async input => {
    const url = new URL(String(input)); requests.push(url);
    if (url.pathname.endsWith('/search/')) return new Response('', { status: 302, headers: { Location: '/434/caw/en/listing/' } });
    if (url.pathname.endsWith('/listing/')) return new Response('<!doctype html><html><head><title>Current Opportunities - CPB</title></head><body><div id="search-results-content"><div class="job-listing"><div class="job-listing-left"><h3><a class="job-link" href="/434/caw/en/job/123/manager">Quality Manager</a></h3><p>Build Australian infrastructure</p></div><span class="location">Aus - Perth</span></div></div></body></html>');
    return new Response('<main id="job-content"><h1>Quality Manager</h1><span class="job-externalJobNo">123</span><span class="location">Aus - Perth</span><a href="https://secure.dc2.pageuppeople.com/apply/434/gateway/default.aspx?c=apply&amp;lJobID=123">Apply Now</a><section class="section-job-overview">Full employer description</section></main>');
  } });
  const jobs = await api.search('quality manager', 2); assert.equal(jobs.length, 1); assert.equal(jobs[0].company, 'CPB');
  assert.equal(requests[1].searchParams.get('page'), '2'); assert.equal(requests[1].searchParams.get('search-keyword'), 'quality manager');
  assert.equal((await api.detail(jobs[0])).description, 'Full employer description');
});

for (const location of ['https://private.invalid/listing/', '/999/cw/en/listing/', '/434/caw/en/login/', '/434/caw/en/search/']) test(`PageUp refuses unsafe or looping results redirects: ${location}`, async () => {
  let calls = 0;
  const api = new EmployerFeedDiscovery('pageup', 'https://careers.pageuppeople.com/434/caw/en', { gapMs: 0, fetch: async () => { calls++; return new Response('', { status: 302, headers: { Location: location } }); } });
  await assert.rejects(api.search('', 1), /None of the selected/); assert.ok(calls <= 3);
});
