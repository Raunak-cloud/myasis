import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmployerFeedDiscovery, employerJobIdentity, feedText, workdayCountryFilter } from './employer-feeds.js';
import { employerTargets, identifierTarget, EMPLOYER_SOURCES } from './employer-source-config.js';

const id = '11111111-2222-4333-8444-555555555555';
const lever = { id, text: 'Product Engineer', country: 'au', categories: { location: 'Sydney' }, descriptionPlain: 'Build reliable products', lists: [{ text: 'Skills', content: '<p>React and Node</p>' }], workplaceType: 'hybrid' };
const greenhouse = { id: 123, title: 'Product Engineer', company_name: 'Fixture Company', location: { name: 'Sydney, Australia' }, content: '&lt;p&gt;Build products&lt;/p&gt;', first_published: '2026-10-01T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' };
const wdRoot = 'https://fixture.wd105.myworkdayjobs.com/en-US/External';
const puRoot = 'https://careers.pageuppeople.com/999/cw/en';
const now = () => Date.parse('2026-10-12T00:00:00Z');
const response = (data: unknown) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status: 200 });

test('all source target contracts refuse local, credentialed, cross-provider and malformed addresses', () => {
  for (const source of EMPLOYER_SOURCES) assert.ok(employerTargets(source.id, source.defaults).length);
  for (const source of ['lever', 'greenhouse'] as const) assert.throws(() => employerTargets(source, 'https://localhost'));
  for (const [source, bad] of [['workday', 'https://localhost/en-US/External'], ['workday', 'https://fixture.wd105.myworkdayjobs.com.evil.test/en-US/External'], ['pageup', 'https://careers.pageuppeople.com/999/cw/en/job/123'], ['pageup', 'https://user:password@careers.pageuppeople.com/999/cw/en']] as const) assert.throws(() => employerTargets(source, bad));
  assert.throws(() => employerJobIdentity('lever', 'https://jobs.lever.co/fixture/not-a-posting'));
  assert.deepEqual(employerTargets('pageup', 'Fixture Company|https://careers.pageuppeople.com/547/eon/en'), ['Fixture Company|https://careers.pageuppeople.com/547/eon/en']);
  assert.deepEqual(employerJobIdentity('pageup', 'https://careers.pageuppeople.com/547/eon/en/job/123/software-engineer'), { namespace: 'https://careers.pageuppeople.com/547/eon/en', posting: '123' });
  assert.throws(() => employerTargets('pageup', 'https://careers.pageuppeople.com/547/../en'));
});

test('Lever retrieves published Australian listings once, leaving relevance to AI and dates unknown', async () => {
  const requests: string[] = [];
  const api = new EmployerFeedDiscovery('lever', 'fixture', { now, gapMs: 0, fetch: async url => {
    requests.push(String(url)); return response(String(url).includes(`/${id}`) ? lever : [lever, { ...lever, id: 'aaaaaaaa-2222-4333-8444-555555555555', country: 'us' }]);
  } });
  const jobs = await api.search('machine learning', 1);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].title, 'Product Engineer', 'no hard-coded keyword/fit filter');
  assert.equal(jobs[0].ageDays, undefined); assert.equal(jobs[0].workArrangement, 'hybrid');
  await api.search('different words', 1); assert.equal(requests.length, 1, 'board fetched once per run');
  const detail = await api.detail(jobs[0]); assert.match(detail.description!, /React and Node/);
  const before = requests.length; await assert.rejects(api.detail({ ...jobs[0], url: jobs[0].url.replace('/fixture/', '/other/') }), /watchlist/); assert.equal(requests.length, before);
});

test('Lever optional native locations narrow the provider snapshot without changing identity or candidate fit', async () => {
  assert.deepEqual(identifierTarget('Fixture Company|fixture|Australia;Remote (AU)'), { name: 'Fixture Company', identifier: 'fixture', locations: ['Australia', 'Remote (AU)'] });
  assert.deepEqual(employerTargets('lever', ' Fixture Company | fixture | Australia ; Australia '), ['Fixture Company|fixture|Australia']);
  assert.deepEqual(identifierTarget(employerTargets('lever', 'Fixture Company|fixture|Sydney%2C Australia;Remote (AU)')[0]).locations, ['Sydney, Australia', 'Remote (AU)']);
  for (const invalid of ['Name|fixture|', 'Name|fixture|A;B;C;D;E;F', 'Name|fixture|Australia|extra']) assert.throws(() => employerTargets('lever', invalid));
  let requests = 0;
  const api = new EmployerFeedDiscovery('lever', 'Fixture Company|fixture|Australia;Remote (AU)', { now, gapMs: 0, fetch: async url => {
    requests++;
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'https://api.lever.co');
    if (parsed.pathname.endsWith(`/${id}`)) return response(lever);
    assert.deepEqual(parsed.searchParams.getAll('location'), ['Australia', 'Remote (AU)']);
    return response([lever]);
  } });
  const [job] = await api.search('unrelated words', 1);
  assert.equal(job.company, 'Fixture Company');
  assert.equal(job.title, 'Product Engineer', 'native location is not a role filter');
  assert.equal(job.id, (await new EmployerFeedDiscovery('lever', 'fixture', { gapMs: 0, fetch: async () => response([lever]) }).search('any', 1))[0].id);
  assert.equal((await api.detail(job)).id, job.id);
  assert.equal(requests, 2);
});

test('complete board snapshots reach AI even when a vacancy follows the old discovery page limit', async () => {
  for (const source of ['lever', 'greenhouse'] as const) {
    let requests = 0;
    const entries = Array.from({ length: 176 }, (_, i) => source === 'lever'
      ? { ...lever, id: `${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`, text: `Vacancy ${i}` }
      : { ...greenhouse, id: i + 1, title: `Vacancy ${i}` });
    const api = new EmployerFeedDiscovery(source, 'fixture', { now, gapMs: 0, fetch: async url => {
      requests++;
      const offset = Number(new URL(String(url)).searchParams.get('skip') ?? 0);
      return response(source === 'lever' ? entries.slice(offset, offset + 100) : { jobs: entries });
    } });
    const jobs = await api.search('any candidate direction', 1);
    assert.equal(jobs.length, 176);
    assert.equal(jobs[145].title, 'Vacancy 145', 'later postings must not be hidden by adaptive discovery');
    const fetched = requests;
    assert.deepEqual(await api.search('same snapshot', 2), []);
    assert.equal((await api.search('another keyword', 1)).length, 176);
    assert.equal(requests, fetched, 'neither later pages nor another keyword refetch the board');
  }
});

test('Greenhouse preserves actual publication dates and ignores edit dates; closed/mismatched jobs fail', async () => {
  let closed = false;
  const api = new EmployerFeedDiscovery('greenhouse', 'fixture', { now, gapMs: 0, fetch: async url => response(String(url).includes('/jobs/123') ? { ...greenhouse, ...(closed ? { application_deadline: '2026-10-11' } : {}) } : { jobs: [greenhouse] }) });
  const jobs = await api.search('AI', 1); assert.equal(jobs[0].ageDays, 11); assert.equal(jobs[0].description, 'Build products');
  assert.equal((await api.detail(jobs[0])).id, jobs[0].id); closed = true; await assert.rejects(api.detail(jobs[0]), /closed/);
  assert.equal(feedText('<script>private()</script><p>safe</p>'), 'safe');
});

test('Workday uses its public careers search operation, stable job path, exact date and country on detail', async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = []; let country = 'Australia';
  const path = '/job/Sydney/Product-Engineer_JR123';
  const api = new EmployerFeedDiscovery('workday', `Fixture Company|${wdRoot}`, { now, gapMs: 0, fetch: async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body as string });
    return response(String(url).endsWith('/jobs') ? { jobPostings: [{ title: 'Product Engineer', locationsText: 'Sydney', externalPath: path }] } : { jobPostingInfo: { title: 'Product Engineer', location: 'Sydney', startDate: '2026-10-10', country: { descriptor: country }, jobDescription: '<p>Build products</p>' } });
  } });
  const jobs = await api.search('software', 2); assert.equal(jobs[0].company, 'Fixture Company'); assert.equal(jobs[0].ageDays, undefined);
  assert.equal(calls[0].method, 'POST'); assert.deepEqual(JSON.parse(calls[0].body!), { limit: 20, offset: 20, searchText: 'software', appliedFacets: {} });
  assert.match(calls[0].url, /\/wday\/cxs\/fixture\/External\/jobs$/);
  const detail = await api.detail(jobs[0]); assert.equal(detail.ageDays, 2); assert.equal(detail.description, 'Build products');
  country = 'United States'; await assert.rejects(api.detail(jobs[0]), /not in Australia/);
});

test('PageUp follows public search paging and requires an active job, stable identity and description', async () => {
  const path = '/999/cw/en/job/123/product-engineer'; let active = true;
  const list = `<table><tbody id="search-results-content"><tr><td><a class="job-link" href="${path}">Product Engineer</a></td><td><span class="location">Sydney, NSW</span></td><td><span class="close-date"><time datetime="2026-11-01">1 Nov</time></span></td></tr><tr class="summary"><td>Build things</td></tr></tbody></table>`;
  const api = new EmployerFeedDiscovery('pageup', `Fixture Company|${puRoot}`, { now, gapMs: 0, fetch: async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/search/')) { assert.equal(parsed.searchParams.get('search-keyword'), 'software'); assert.equal(parsed.searchParams.get('page'), '1'); return response(list); }
    return response(`<div id="job-content"><h2>Product Engineer</h2><span class="job-externalJobNo">123</span><span class="location">Sydney, NSW</span><div id="job-details"><p>Build products</p></div><span class="open-date"><time datetime="2026-10-09"></time></span><span class="close-date"><time datetime="2026-11-01"></time></span>${active ? '<a class="apply-link" href="https://secure.dc2.pageuppeople.com/apply/999">Apply now</a>' : ''}</div>`);
  } });
  const jobs = await api.search('software', 1); assert.equal(jobs[0].company, 'Fixture Company');
  assert.equal((await api.detail(jobs[0])).ageDays, 3); active = false; await assert.rejects(api.detail(jobs[0]), /closed/);
});

test('one broken employer does not hide working feeds; total failure is visible, not an empty success', async () => {
  const warnings: string[] = [];
  const api = new EmployerFeedDiscovery('greenhouse', 'broken,fixture', { gapMs: 0, warn: value => warnings.push(value), fetch: async url => String(url).includes('/broken/') ? new Response('', { status: 429 }) : response({ jobs: [greenhouse] }) });
  assert.equal((await api.search('software', 1)).length, 1); assert.equal(warnings.length, 1);
  const broken = new EmployerFeedDiscovery('greenhouse', 'broken', { gapMs: 0, fetch: async () => new Response('', { status: 403 }) });
  await assert.rejects(broken.search('software', 1), /None of the selected/);
});

test('response limits, redirect refusal and timeouts also apply to Workday public search POSTs', async () => {
  const api = new EmployerFeedDiscovery('workday', wdRoot, { gapMs: 0, timeoutMs: 1000, fetch: async (_url, init) => {
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); assert.equal(init?.method, 'POST');
    return new Response('x'.repeat(8_000_001));
  } });
  await assert.rejects(api.search('software', 1), /None of the selected/);
});

test('malformed Workday rows cannot choose another host and do not hide valid listings', async () => {
  const warnings: string[] = [];
  const api = new EmployerFeedDiscovery('workday', wdRoot, { gapMs: 0, warn: value => warnings.push(value), fetch: async () => response({ jobPostings: [
    { title: 'Poisoned', locationsText: 'Sydney', externalPath: '/../../https://localhost/private' },
    { title: 'Valid', locationsText: 'Sydney', externalPath: '/job/Sydney/Valid_JR123' },
  ] }) });
  const jobs = await api.search('software', 1); assert.equal(jobs.length, 1); assert.equal(jobs[0].title, 'Valid'); assert.equal(warnings.length, 1);
});

test('Workday uses nested provider-supplied country facets before paging instead of losing Australian jobs behind global results', async () => {
  const calls: any[] = [];
  const facets = [{ facetParameter: 'locationGroup', values: [{ descriptor: 'Country', facetParameter: 'employerSpecificCountryField', values: [{ descriptor: 'Australia', id: 'dynamic-au-id' }] }] }];
  const api = new EmployerFeedDiscovery('workday', wdRoot, { gapMs: 0, fetch: async (_url, init) => {
    const request = JSON.parse(init!.body as string); calls.push(request);
    return response(Object.keys(request.appliedFacets).length ? { jobPostings: [{ title: 'Australian Developer', locationsText: 'Sydney', externalPath: '/job/Sydney/Developer_JR42' }] } : { jobPostings: [{ title: 'Global first page', locationsText: 'New York', externalPath: '/job/New-York/Developer_JR41' }], facets });
  } });
  const jobs = await api.search('software', 1); assert.equal(jobs[0].title, 'Australian Developer');
  assert.deepEqual(calls[1].appliedFacets, { employerSpecificCountryField: ['dynamic-au-id'] });
  await api.search('AI', 2); assert.equal(calls.length, 3, 'discovered country IDs are reused across queries');
  assert.equal(calls[2].offset, 20); assert.equal(calls[2].searchText, 'AI');
  assert.deepEqual(workdayCountryFilter(facets), { employerSpecificCountryField: ['dynamic-au-id'] });
  assert.equal(workdayCountryFilter([{ descriptor: 'Country', facetParameter: 'country', values: [{ descriptor: 'Canada', id: 'ca' }] }]), null);
  assert.equal(workdayCountryFilter([{ descriptor: 'Location', facetParameter: 'locations', values: [{ descriptor: 'Sydney', id: 'syd' }] }]), undefined);
});
