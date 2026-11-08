import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdzunaDiscovery, adzunaListing } from './adzuna.js';
import { adzunaConfigured } from './adzuna-config.js';
import { enabledPlatforms } from './platforms.js';
import { sameApplication } from './application-identity.js';
import type { AppliedRecord } from './types.js';

const raw = { id: '123456789', title: 'Senior Data Analyst', company: { display_name: 'Example Employer' },
  location: { display_name: 'Sydney, NSW' }, created: '2026-11-07T00:00:00Z', description: 'Short API summary only.',
  redirect_url: 'https://www.adzuna.com.au/jobs/land/ad/123456789?utm_source=owtomate',
  salary_min: 120000, salary_max: 150000, salary_is_predicted: '0' };
const scope = { location: 'Sydney', radiusKm: 25, arrangements: ['onsite' as const], label: 'Sydney office' };

test('Adzuna needs explicit installation enablement and both credentials', () => {
  for (const env of [{}, { ADZUNA_ENABLED: 'true' }, { ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key' }]) assert.equal(adzunaConfigured(env), false);
  assert.equal(adzunaConfigured({ ADZUNA_ENABLED: 'true', ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key' }), true);
  assert.deepEqual(enabledPlatforms('seek,adzuna', false, false).map(p => p.id), ['seek']);
  assert.deepEqual(enabledPlatforms('adzuna', false, true).map(p => p.id), ['adzuna']);
});

test('API summary becomes a namespaced Australian search card, never a full description', () => {
  const job = adzunaListing(raw, Date.parse('2026-11-08T00:00:00Z'))!;
  assert.equal(job.id, 'adzuna-123456789'); assert.equal(job.platform, 'adzuna');
  assert.equal(job.ageDays, 1); assert.equal(job.description, undefined);
  assert.equal(job.teaser, raw.description); assert.equal(job.listingSourceUrl, raw.redirect_url);
  assert.equal(job.salary, 'AUD 120,000–150,000 per year'); assert.equal(job.applicationMode, 'unknown');
});

test('estimated or unknown salary provenance never becomes disclosed or filtering salary', () => {
  for (const salary_is_predicted of ['1', 1, undefined, null]) {
    const job = adzunaListing({ ...raw, salary_is_predicted })!;
    assert.equal(job.salary, undefined); assert.equal(job.inferredMinSalary, undefined);
  }
});

test('malformed cards and forged redirect destinations are discarded', () => {
  for (const redirect_url of ['https://adzuna.com.au.evil.test/jobs/land/ad/123456789', 'https://localhost/jobs/land/ad/123456789',
    'https://www.adzuna.com.au/jobs/land/ad/999', 'https://user:password@www.adzuna.com.au/jobs/land/ad/123456789', 'file:///secret']) {
    assert.equal(adzunaListing({ ...raw, redirect_url }), null);
  }
  assert.equal(adzunaListing({ ...raw, id: '../private' }), null);
  assert.equal(adzunaListing({ ...raw, title: '' }), null);
  assert.match(adzunaListing({ ...raw, redirect_url: raw.redirect_url.replace('https:', 'http:') })!.url, /^https:/);
});

test('search uses the Australian endpoint, location, radius, age, date ordering and per-run cache', async () => {
  const requests: URL[] = [];
  const discovery = new AdzunaDiscovery({ appId: 'private-id', appKey: 'private-key', maxAgeDays: 7, fetch: async (input, init) => {
    const url = new URL(String(input)); requests.push(url);
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    return Response.json({ results: [raw, raw] });
  } });
  const jobs = await discovery.search('Data analyst', 2, scope);
  assert.equal(jobs.length, 1);
  assert.deepEqual(await discovery.search('Data analyst', 2, scope), jobs); assert.equal(requests.length, 1);
  assert.deepEqual(await discovery.search('Data analyst',2,{...scope,arrangements:['hybrid'],label:'Same location, different display label'}),jobs);
  assert.equal(requests.length,1,'Equivalent API requests share the same cached result.');
  const url = requests[0]; assert.equal(url.origin + url.pathname, 'https://api.adzuna.com/v1/api/jobs/au/search/2');
  for (const [key, value] of Object.entries({ where: 'Sydney', distance: '25', max_days_old: '7', what: 'Data analyst', sort_by: 'date', results_per_page: '50' })) assert.equal(url.searchParams.get(key), value);
  assert.equal(url.searchParams.has('salary_min'), false);
  await discovery.search('Data analyst', 1, { ...scope, location: '', radiusKm: 0 });
  assert.equal(requests[1].searchParams.has('where'), false); assert.equal(requests[1].searchParams.has('distance'), false);
});

test('page validation, exhausted results and invalid response bodies are explicit', async () => {
  const discovery = new AdzunaDiscovery({ appId: 'id', appKey: 'key', fetch: async () => Response.json({ results: [] }) });
  await assert.rejects(discovery.search('x', 0), /Invalid Adzuna/); assert.deepEqual(await discovery.search('x', 1), []);
  for (const body of ['not json', '{}', 'x'.repeat(2_000_001)]) {
    const malformed = new AdzunaDiscovery({ appId: 'id', appKey: 'key', fetch: async () => new Response(body) });
    await assert.rejects(malformed.search('x', 1), /invalid or oversized/);
  }
});

test('authentication and quota refusals stop further requests for the run without exposing secrets', async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const discovery = new AdzunaDiscovery({ appId: 'id', appKey: 'key', fetch: async () => { calls++; return new Response('secret response', { status }); } });
    await assert.rejects(discovery.search('x', 1), new RegExp(`HTTP ${status}`));
    await assert.rejects(discovery.search('x', 2), /rest of this run/); assert.equal(calls, 1);
  }
  const failure = new AdzunaDiscovery({ appId: 'id', appKey: 'private-key', fetch: async input => { throw new Error(String(input)); } });
  await assert.rejects(failure.search('x', 1), error => error instanceof Error && !error.message.includes('private-key') && !error.message.includes('app_key'));
});

test('resolved Adzuna mirrors share application identity with prior board and employer records', () => {
  const job = { ...adzunaListing(raw)!, url: 'https://www.seek.com.au/job/95593975', applicationUrl: 'https://www.seek.com.au/job/95593975/apply' };
  const prior = { jobId: '95593975', platform: 'seek', company: job.company, title: job.title, location: job.location,
    url: 'https://www.seek.com.au/job/95593975', appliedAt: '2026-11-07', score: 99, scoreReasons: [] } as AppliedRecord;
  assert.equal(sameApplication(prior, job), true);
  assert.equal(sameApplication(prior,{...job,url:job.url+'?source=adzuna',applicationUrl:job.applicationUrl+'?ref=adzuna'}),true);
  assert.equal(sameApplication({...prior,jobId:'95593976',url:'https://www.seek.com.au/job/95593976'},job),false);
  const indeed={...job,url:'https://au.indeed.com/viewjob?jk=0123456789abcdef&from=adzuna',applicationUrl:'https://au.indeed.com/jobs?vjk=0123456789abcdef&from=adzuna'};
  assert.equal(sameApplication({...prior,platform:'indeed',jobId:'0123456789abcdef',url:'https://au.indeed.com/viewjob?jk=0123456789abcdef'},indeed),true);
  assert.equal(sameApplication({...prior,platform:'indeed',jobId:'1123456789abcdef',url:'https://au.indeed.com/viewjob?jk=1123456789abcdef'},indeed),false);
  const employer = 'https://example.com/jobs/87108?utm_source=adzuna';
  assert.equal(sameApplication({ ...prior, url: 'https://example.com/jobs/87108' }, { ...job, url: employer, applicationUrl: employer }), true);
  assert.equal(sameApplication({ ...prior, url: 'https://example.com/jobs/87109' }, { ...job, url: employer, applicationUrl: employer }), false);
});
