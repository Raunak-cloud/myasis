import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmployerFeedDiscovery, employerJobIdentity } from './employer-feeds.js';
import { workdayDirectoryTargets } from './workday-directory.js';

const board = 'https://careers.pageuppeople.com/539/caw/en';
const origin = 'https://careers.fixture.org';
const jobUrl = origin + '/jobs/revenue-analyst-sydney';
const listing = (next = false) => `<form class="job-search-results-form" action="${origin}/jobs/search"><input name="query"></form>
  <div class="job-search-results-content"><article class="job-search-results-card">
  <h3 class="job-search-results-card-title"><a href="${jobUrl}">Revenue Analyst</a></h3>
  <div class="job-component-location">Sydney, NSW</div><p class="job-search-results-summary">Analyse Australian revenue</p></article></div>
  <div class="pagination-container">${next ? '<a href="?query=analyst&page=2" rel="next">Next</a>' : 'Displaying 1 entry'}</div>`;
const detail = (expires = '2027-01-01', description = '<p>Analyse Australian revenue in Power BI.</p>') => `<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting', title: 'Revenue Analyst', description, datePosted: '2026-11-12', validThrough: expires,
  hiringOrganization: { name: 'Verified Employer' }, jobLocation: [{ address: { addressLocality: 'Sydney', addressRegion: 'NSW', addressCountry: 'AU' } }],
})}</script>`;
const validatePublicUrl = async (url: string) => { assert.equal(new URL(url).origin, origin); return url; };

test('PageUp branded redirects retain the exact keyword/page and publish a stable, fresh employer job', async () => {
  const requests: URL[] = []; let expired = false, changed = false;
  const network: typeof fetch = async input => {
    const u = new URL(String(input)); requests.push(u);
    if (u.hostname === 'careers.pageuppeople.com') return new Response('', { status: 302, headers: { Location: origin + '/' } });
    if (u.pathname === '/') return new Response('', { status: 202 });
    if (u.pathname === '/jobs/search') return new Response(listing());
    return new Response(detail(expired ? '2026-01-01' : '2027-01-01', changed ? 'Updated employer description.' : undefined));
  };
  const options = { fetch: network, validatePublicUrl, gapMs: 0, now: () => Date.parse('2026-11-14') };
  const api = new EmployerFeedDiscovery('pageup', board, options);
  const [job] = await api.search('Data & Insights', 2);
  assert.equal(job.url, jobUrl); assert.equal(job.sourceCareerSite, board);
  const requested = requests.find(u => u.searchParams.has('query'))!;
  assert.equal(requested.searchParams.get('query'), 'Data & Insights'); assert.equal(requested.searchParams.get('page'), '2');
  assert.equal(requests.some(u=>u.origin===origin&&u.pathname==='/'),false,'a careers home page is not a search endpoint');
  const full = await api.detail(job); assert.equal(full.company, 'Verified Employer'); assert.equal(full.ageDays, 2);
  assert.equal(full.description, 'Analyse Australian revenue in Power BI.');
  changed = true; assert.equal((await api.detail(job)).description, 'Updated employer description.', 'details are fetched fresh');
  const fresh = new EmployerFeedDiscovery('pageup', board, options);
  assert.equal((await fresh.search('another query', 1))[0].id, job.id);
  assert.equal((await fresh.detail({ ...job, sourceCareerSite: undefined })).id, job.id, 'index tasks retain board provenance in their target');
  expired = true; await assert.rejects(api.detail(job), /closed/);
  const before = requests.length; assert.deepEqual(await api.search('Data & Insights', 3), []);
  assert.equal(requests.length, before, 'a finished employer query is not requested on every later aggregate page');
});

test('PageUp supports a public crawler that already followed the branded redirect', async () => {
  const api = new EmployerFeedDiscovery('pageup', board, { validatePublicUrl, gapMs: 0, fetch: async () => new Response(listing()) });
  assert.equal((await api.search('analyst', 1))[0].url, jobUrl);
});

test('a fresh background-index task can verify and refresh a branded PageUp job after its reader follows redirects', async () => {
  const options={validatePublicUrl,gapMs:0,fetch:async(input:Parameters<typeof fetch>[0])=>new Response(new URL(String(input)).pathname.includes('/jobs/revenue-')?detail():listing())};
  const first=new EmployerFeedDiscovery('pageup',board,options),[job]=await first.search('analyst',1);
  const fresh=new EmployerFeedDiscovery('pageup',board,options);
  const refreshed=await fresh.detail({...job,sourceCareerSite:undefined});
  assert.equal(refreshed.id,job.id);assert.equal(refreshed.description,'Analyse Australian revenue in Power BI.');
});

test('PageUp verification pages are reported as blocked access, never an empty successful search', async () => {
  const warnings:string[]=[];let calls=0;
  const api=new EmployerFeedDiscovery('pageup',board,{gapMs:0,validatePublicUrl,warn:s=>warnings.push(s),fetch:async input=>{
    calls++;return String(input).includes('pageuppeople.com')?new Response('',{status:302,headers:{Location:origin+'/jobs/search'}})
      :new Response('<html>verification</html>',{status:202,headers:{'x-amzn-waf-action':'challenge'}});
  }});
  await assert.rejects(api.search('data',1),/None of the selected/);assert.match(warnings[0],/security verification/);assert.equal(calls,2);
  await assert.rejects(api.search('another query',1),/None of the selected/);assert.equal(calls,2,'verification is not hammered on every keyword');
});

for (const destination of ['https://127.0.0.1/jobs/search', 'http://careers.fixture.org/jobs/search', 'https://careers.fixture.org/login', 'https://user:secret@careers.fixture.org/jobs/search']) {
  test(`PageUp does not follow a non-public or non-career redirect: ${destination}`, async () => {
    let calls = 0;
    const api = new EmployerFeedDiscovery('pageup', board, { gapMs: 0, validatePublicUrl: async raw => {
      const u = new URL(raw);if (u.protocol !== 'https:' || u.username || u.password || u.hostname !== 'careers.fixture.org') throw Error('Not a public career URL.');return raw;
    }, fetch: async () => { calls++; return new Response('', { status: 302, headers: { Location: destination } }); } });
    await assert.rejects(api.search('analyst', 1), /None of the selected/); assert.equal(calls, 1);
  });
}

test('PageUp branded job refresh refuses another employer, expired or mismatched publisher metadata', async () => {
  let wrong = false;
  const api = new EmployerFeedDiscovery('pageup', board, { gapMs: 0, validatePublicUrl, fetch: async input => {
    const u = new URL(String(input));
    if (u.hostname === 'careers.pageuppeople.com') return new Response('', { status: 302, headers: { Location: origin + '/jobs/search' } });
    return new Response(u.pathname === '/jobs/search' ? listing() : wrong ? '<script type="application/ld+json">{"@type":"JobPosting","url":"https://careers.fixture.org/jobs/different","title":"Other","description":"Other"}</script>' : detail());
  } });
  const [job] = await api.search('analyst', 1);
  await assert.rejects(api.detail({ ...job, sourceCareerSite: 'https://careers.pageuppeople.com/999/cw/en' }), /verified PageUp board/);
  wrong = true; await assert.rejects(api.detail(job), /closed, changed/);
  assert.throws(() => employerJobIdentity('pageup', 'https://127.0.0.1/jobs/analyst'));
});

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

test('PageUp branded search uses its offered Australian country filter without changing keywords', async () => {
  let selected:URL|undefined;
  const api=new EmployerFeedDiscovery('pageup',board,{gapMs:0,validatePublicUrl,fetch:async input=>{
    const u=new URL(String(input));
    if(u.hostname==='careers.pageuppeople.com')return new Response('',{status:302,headers:{Location:origin+'/jobs/search'}});
    if(u.searchParams.has('query'))selected=u;
    return new Response(listing().replace('<input name="query">','<input name="query"><input name="country_codes[]" value="AU">'));
  }});
  await api.search('Data & Insights',1);assert.equal(selected?.searchParams.get('country_codes[]'),'AU');assert.equal(selected?.searchParams.get('query'),'Data & Insights');
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

for (const source of ['pageup','workday'] as const) test(`${source} endpoint failures cool down across instances while healthy employers continue`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owtomate-feed-health-'));let now = 10000000, bad = 0, good = 0;
  const targets = source === 'pageup' ? 'https://careers.pageuppeople.com/1/cw/en,https://careers.pageuppeople.com/2/cw/en'
    : 'https://bad.wd3.myworkdayjobs.com/en-US/Careers,https://good.wd3.myworkdayjobs.com/en-US/Careers';
  const network: typeof fetch = async input => {
    if (/\/1\/|\/bad\./.test(String(input))) { bad++;return new Response('', { status: 404 }); }
    good++;return source === 'workday' ? Response.json({ jobPostings: [] }) : new Response('<div id="search-results-content"></div>');
  };
  try {
    const options = { gapMs: 0, healthDirectory: dir, now: () => now, fetch: network };
    await new EmployerFeedDiscovery(source, targets, options).search('data', 1);
    await new EmployerFeedDiscovery(source, targets.split(',').map((url,i)=>`Label ${i}|${source==='workday'?url.replace('/en-US/','/en-GB/'):url}`).join(','), options).search('reporting', 1);
    assert.equal(bad, 1);assert.equal(good, 2);
    now += 3600_001;await new EmployerFeedDiscovery(source, targets, options).search('data', 1);
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

test('PageUp ignores repeated pagination only after recovering the complete publisher feed', async () => {
  let calls = 0;
  const api = new EmployerFeedDiscovery('pageup', board, { gapMs: 0, now: () => Date.parse('2026-11-14'), fetch: async input => {
    calls++;
    if (String(input).endsWith('/jobs.json')) return Response.json([
      {Id:'123',Title:'Analyst',Locations:'Sydney',Overview:'Full first role',OpeningDateUtc:`/Date(${Date.parse('2026-11-12')})/`},
      {Id:'456',Title:'Later BI Analyst',Locations:'Sydney',Overview:'Full later role',ClosingDateUtc:`/Date(${Date.parse('2027-01-01')})/`},
      {Id:'789',Title:'Closed',Locations:'Sydney',Overview:'Closed',ClosingDateUtc:`/Date(${Date.parse('2026-01-01')})/`},
    ]);
    return new Response('<div id="search-results-content"><div class="job-listing"><a class="job-link" href="/539/caw/en/job/123/analyst">Analyst</a><span class="location">Sydney</span></div></div>');
  } });
  assert.equal((await api.search('data', 1)).length, 1);
  const recovered=await api.search('data', 2);assert.equal(recovered.length,2);assert.equal(recovered[0].ageDays,2);
  assert.ok(recovered.some(job=>job.title==='Later BI Analyst'&&job.description==='Full later role'));
  await api.search('data', 3);assert.equal(calls, 3);
  assert.equal((await api.search('reporting', 1)).length, 1);assert.equal(calls, 4);
});

test('PageUp expired cards on one page cannot hide active jobs on a later page', async () => {
  let calls=0;
  const api=new EmployerFeedDiscovery('pageup',board,{gapMs:0,now:()=>Date.parse('2026-11-14'),fetch:async input=>{
    calls++;const page=new URL(String(input)).searchParams.get('page');
    return new Response(`<div id="search-results-content"><div class="job-listing"><a class="job-link" href="/539/caw/en/job/${page==='1'?'123':'456'}/analyst">Analyst</a><span class="location">Sydney</span><span class="close-date"><time datetime="${page==='1'?'2026-01-01':'2027-01-01'}"></time></span></div></div>`);
  }});
  assert.deepEqual(await api.search('data',1),[]);
  assert.equal((await api.search('data',2)).length,1,'filtering a closed card is not evidence of result exhaustion');assert.equal(calls,2);
});

test('PageUp malformed branded cards cannot hide a publisher-advertised next page', async () => {
  let pages=0;
  const api=new EmployerFeedDiscovery('pageup',board,{gapMs:0,validatePublicUrl,fetch:async input=>{
    const u=new URL(String(input));
    if(u.hostname==='careers.pageuppeople.com')return new Response('',{status:302,headers:{Location:origin+'/jobs/search'}});
    pages++;return new Response(u.searchParams.get('page')==='1'?listing(true).replace(jobUrl,'https://other-employer.org/jobs/not-this-board'):listing());
  }});
  assert.deepEqual(await api.search('data',1),[]);assert.equal((await api.search('data',2)).length,1);assert.equal(pages,2);
});
