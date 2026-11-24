import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmployerFeedDiscovery, feedText, workdayCountryFilter } from './employer-feeds.js';
import { employerTargets, EMPLOYER_SOURCES } from './employer-source-config.js';

const greenhouse = { id: 123, title: 'Product Engineer', company_name: 'Fixture Company', location: { name: 'Sydney, Australia' }, content: '&lt;p&gt;Build products&lt;/p&gt;', first_published: '2026-10-01T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' };
const wdRoot = 'https://fixture.wd105.myworkdayjobs.com/en-US/External';
const now = () => Date.parse('2026-10-12T00:00:00Z');
const response = (data: unknown) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status: 200 });

test('removed providers cannot instantiate a discovery adapter', () => {
  for (const source of ['lever', 'smartrecruiters', 'pageup']) {
    assert.throws(() => new EmployerFeedDiscovery(source as never), /no longer available/);
  }
});

for (const failure of ['timeout', 'network', 'server', 'body-timeout'] as const) test(`public career reads recover once from a transient ${failure}`, async () => {
  let calls = 0;
  const api = new EmployerFeedDiscovery('greenhouse', 'fixture', { gapMs: 0, retryDelayMs: 0, fetch: async () => {
    if (++calls === 1) {
      if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
      if (failure === 'network') throw new TypeError('fetch failed');
      if (failure === 'server') return new Response('', { status: 503 });
      return new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('Timed out reading body', 'TimeoutError')); } }));
    }
    return response({ jobs: [greenhouse] });
  } });
  assert.equal((await api.search('software', 1)).length, 1);
  assert.equal(calls, 2);
});

for (const status of [403, 429, 503]) test(`HTTP ${status} failures remain bounded without bypassing access restrictions`, async () => {
  let calls = 0;
  const api = new EmployerFeedDiscovery('greenhouse', 'fixture', { gapMs: 0, retryDelayMs: 0, fetch: async () => { calls++; return new Response('', { status }); } });
  await assert.rejects(api.search('software', 1), /None of the selected/);
  assert.equal(calls, status === 503 ? 2 : 1);
});

test('invalid provider data is not repeatedly fetched', async () => {
  let calls = 0;
  const api = new EmployerFeedDiscovery('greenhouse', 'fixture', { gapMs: 0, retryDelayMs: 0, fetch: async () => { calls++; return response('not JSON'); } });
  await assert.rejects(api.search('software', 1), /None of the selected/);
  assert.equal(calls, 1);
});

test('a native fetch redirect refusal is not treated as a transient network outage', async () => {
  let calls = 0;
  const api = new EmployerFeedDiscovery('greenhouse', 'fixture', { gapMs: 0, retryDelayMs: 0, fetch: async () => {
    calls++; throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  } });
  await assert.rejects(api.search('software', 1), /None of the selected/);
  assert.equal(calls, 1);
});

test('all source target contracts refuse local, credentialed, cross-provider and malformed addresses', () => {
  for (const source of EMPLOYER_SOURCES) assert.ok(employerTargets(source.id, source.defaults).length);
  for (const source of ['greenhouse'] as const) assert.throws(() => employerTargets(source, 'https://localhost'));
  for (const [source, bad] of [['workday', 'https://localhost/en-US/External'], ['workday', 'https://fixture.wd105.myworkdayjobs.com.evil.test/en-US/External'], ['workday', 'https://fixture.wd105.myworkdayjobs.com/en-US/External/job/Sydney/123'], ['workday', 'https://user:password@fixture.wd105.myworkdayjobs.com/en-US/External']] as const) assert.throws(() => employerTargets(source, bad));
});

test('complete board snapshots reach AI even when a vacancy follows the old discovery page limit', async () => {
  for (const source of ['greenhouse'] as const) {
    let requests = 0;
    const entries = Array.from({ length: 176 }, (_, i) => ({ ...greenhouse, id: i + 1, title: `Vacancy ${i}` }));
    const api = new EmployerFeedDiscovery(source, 'fixture', { now, gapMs: 0, fetch: async () => {
      requests++;
      return response({ jobs: entries });
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

test('Greenhouse searches both configured and discovered public boards exactly once', async () => {
  const boards: string[] = [];
  const api = new EmployerFeedDiscovery('greenhouse', 'fixture', { now, gapMs: 0,
    additionalTargets: ['FIXTURE', 'https://job-boards.greenhouse.io/later', 'https://private.invalid/boards/ignore'],
    fetch: async input => {
      const board = new URL(String(input)).pathname.split('/')[3];
      boards.push(board);
      return response({ jobs: [{ ...greenhouse, title: `Role from ${board}` }] });
    },
  });
  const snapshot = await api.searchBatch('software', 1);
  assert.equal(snapshot.hasMore, false);
  assert.deepEqual(snapshot.jobs.map(job => job.title), ['Role from fixture', 'Role from later']);
  assert.deepEqual(await api.searchBatch('software', 2), { jobs: [], hasMore: false });
  assert.deepEqual(boards, ['fixture', 'later']);
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
  const detail = await api.detail(jobs[0]); assert.equal(detail.ageDays, 2); assert.equal(detail.description, 'Build products'); assert.equal(detail.locationCountry, 'Australia');
  country = 'United States'; await assert.rejects(api.detail(jobs[0]), /not in Australia/);
});

test('Workday advances after an unreadable page and stops at the publisher total', async () => {
  const offsets: number[] = [];
  const api = new EmployerFeedDiscovery('workday', wdRoot, { now, gapMs: 0, fetch: async (_url, init) => {
    const { offset } = JSON.parse(String(init?.body));
    offsets.push(offset);
    const jobPostings = offset === 0
      ? Array.from({ length: 20 }, (_, index) => ({ externalPath: `/job/Sydney/Role_JR${index}` }))
      : [{ title: 'Later match', locationsText: 'Sydney', externalPath: '/job/Sydney/Later_JR20' }];
    return response({ total: 21, jobPostings });
  } });
  assert.deepEqual(await api.searchBatch('software', 1), { jobs: [], hasMore: true });
  const last = await api.searchBatch('software', 2);
  assert.deepEqual(last.jobs.map(job => job.title), ['Later match']);
  assert.equal(last.hasMore, false);
  assert.deepEqual(await api.searchBatch('software', 3), { jobs: [], hasMore: false });
  assert.deepEqual(offsets, [0, 20]);
});

test('Workday bounds a repeating raw page even when none of its jobs can be read', async () => {
  let calls = 0;
  const api = new EmployerFeedDiscovery('workday', wdRoot, { now, gapMs: 0, fetch: async () => {
    calls++;
    return response({ total: 1000, jobPostings: [{ externalPath: '/job/Sydney/Role_JR1' }] });
  } });
  assert.deepEqual(await api.searchBatch('software', 1), { jobs: [], hasMore: true });
  assert.deepEqual(await api.searchBatch('software', 2), { jobs: [], hasMore: false });
  assert.deepEqual(await api.searchBatch('software', 3), { jobs: [], hasMore: false });
  assert.equal(calls, 2);
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
