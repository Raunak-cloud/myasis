import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmartRecruitersDiscovery, smartRecruitersCompanies, smartRecruitersIdentity, smartRecruitersListing } from './smartrecruiters.js';
import { enabledPlatforms } from './platforms.js';

const posting = (extra: Record<string, unknown> = {}) => ({
  id: '123456789', name: 'Software Engineer', company: { identifier: 'Canva', name: 'Canva' },
  location: { city: 'Sydney', region: 'NSW', country: 'au', remote: true },
  releasedDate: '2026-10-10T00:00:00Z', visibility: 'PUBLIC', ...extra,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('employer identifiers are bounded and cannot become URLs or traversal paths', () => {
  assert.deepEqual(smartRecruitersCompanies(' Canva, KPMGAustralia1,Canva,Colliers '), ['Canva', 'KPMGAustralia1', 'Colliers']);
  for (const value of ['', 'https://localhost', '../private', 'Canva?destination=INTERNAL', 'Canva/Other', Array.from({ length: 21 }, (_, i) => `Employer${i}`).join(',')]) {
    assert.throws(() => smartRecruitersCompanies(value));
  }
  assert.deepEqual(enabledPlatforms('seek,smartrecruiters', false).map(p => p.id), ['seek']);
  assert.deepEqual(enabledPlatforms('smartrecruiters', true).map(p => p.id), ['smartrecruiters']);
});

test('listings preserve identity, Australian location and age without inventing salary or on-site work', () => {
  const job = smartRecruitersListing(posting(), 'Canva', Date.parse('2026-10-12T00:00:00Z'))!;
  assert.equal(job.ageDays, 2);
  assert.equal(job.location, 'Sydney, NSW, Australia');
  assert.equal(job.applicationMode, 'external');
  assert.equal(job.platform, 'smartrecruiters');
  assert.equal(job.salary, undefined);
  assert.ok(job.id.length <= 64);
  assert.equal(smartRecruitersListing(posting({ postingUrl: `${job.url}-different-slug` }), 'Canva')!.id, job.id);
  assert.equal(smartRecruitersListing(posting({ location: { country: 'au', city: 'Sydney' } }), 'Canva')!.workArrangement, undefined);
  for (const item of [posting({ location: { country: 'us' } }), posting({ active: false }), posting({ visibility: 'INTERNAL' }), posting({ company: { identifier: 'Other' } }), posting({ id: 'invalid' })]) {
    assert.equal(smartRecruitersListing(item, 'Canva'), null);
  }
  for (const url of ['http://jobs.smartrecruiters.com/Canva/123456789', 'https://localhost/Canva/123456789', 'https://jobs.smartrecruiters.com.evil.example/Canva/123456789', 'https://user:pass@jobs.smartrecruiters.com/Canva/123456789', 'https://jobs.smartrecruiters.com/Canva/123456789/extra']) {
    assert.throws(() => smartRecruitersIdentity(url));
  }
  assert.throws(() => smartRecruitersListing(posting({ applyUrl: 'https://localhost/private' }), 'Canva'));
  assert.throws(() => smartRecruitersListing(posting({ applyUrl: 'https://jobs.smartrecruiters.com/Canva/987654321' }), 'Canva'));
});

test('age-window search uses public date-filtered Australian requests without a six-batch ceiling', async () => {
  const calls: URL[] = [];
  const client = new SmartRecruitersDiscovery('Canva', { maxAgeDays: 20, gapMs: 0, fetch: (async (raw, options) => {
    const url = new URL(String(raw)); calls.push(url);
    assert.equal(url.origin, 'https://api.smartrecruiters.com');
    assert.equal(url.searchParams.get('country'), 'au');
    assert.equal(url.searchParams.get('destination'), 'PUBLIC');
    assert.equal(url.searchParams.get('q'), 'software engineer');
    assert.equal(url.searchParams.get('limit'), '50');
    const cutoff = Date.parse(url.searchParams.get('releasedAfter')!);
    assert.ok(Math.abs(Date.now() - cutoff - 21 * 86400000) < 1000);
    assert.equal(options?.method, undefined, 'default GET, never application POST');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).has('Authorization'), false);
    return response({ content: [posting(), posting(), posting({ location: { country: 'us' } })] });
  }) as typeof fetch });
  assert.equal((await client.search('software engineer', 1)).length, 1);
  await client.search('software engineer', 9);
  assert.equal(calls[0].searchParams.get('offset'), '0');
  assert.equal(calls[1].searchParams.get('offset'), '400');
});

test('one employer outage preserves others, reports partial coverage and does not retry throttling', async () => {
  const warnings: string[] = [];
  let calls = 0;
  const client = new SmartRecruitersDiscovery('Broken,Canva', { gapMs: 0, warn: line => warnings.push(line), fetch: (async (url) => {
    calls++;
    return String(url).includes('/Broken/') ? response({}, 429) : response({ content: [posting()] });
  }) as typeof fetch });
  assert.equal((await client.search('software', 1)).length, 1);
  assert.equal(calls, 2);
  assert.match(warnings[0], /Broken.*HTTP 429/);
  const failed = new SmartRecruitersDiscovery('Broken', { gapMs: 0, fetch: (async () => response({}, 503)) as typeof fetch });
  await assert.rejects(failed.search('software', 1), /None of the selected/);
});

test('detail rechecks active public Australian jobs and reads every description section as plain text', async () => {
  let closed = false;
  const client = new SmartRecruitersDiscovery('Canva', { gapMs: 0, fetch: (async (url) => {
    assert.equal(String(url), 'https://api.smartrecruiters.com/v1/companies/Canva/postings/123456789');
    return response(posting({ active: !closed, jobAd: { sections: {
      companyDescription: { text: '<p>About &amp; company</p>' }, jobDescription: { text: '<p>Build software.</p><script>ignore this</script>' },
      qualifications: { text: '<p>Degree &#38; experience.</p>' }, additionalInformation: { text: '<p>Hybrid work.</p>' },
    } } }));
  }) as typeof fetch });
  const stub = smartRecruitersListing(posting({ ref: 'https://localhost/private' }), 'Canva')!;
  const job = await client.detail(stub);
  assert.match(job.description!, /About & company.*Build software.*Degree & experience.*Hybrid work/s);
  assert.doesNotMatch(job.description!, /<p>|<script>|ignore this/);
  closed = true;
  await assert.rejects(client.detail(stub), /closed, changed/);
  await assert.rejects(client.detail({ ...stub, url: 'https://jobs.smartrecruiters.com/Other/123456789' }), /outside.*watchlist/);
});

test('oversized responses are rejected and requests have bounded timeouts', async () => {
  const oversized = new SmartRecruitersDiscovery('Canva', { gapMs: 0, fetch: (async () => new Response('x'.repeat(1_000_001))) as typeof fetch });
  await assert.rejects(oversized.detail(smartRecruitersListing(posting(), 'Canva')!), /size limit/);
  const timed = new SmartRecruitersDiscovery('Canva', { gapMs: 0, timeoutMs: 10, fetch: (async (_url, options) => {
    await new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture did not receive request abort')), 500);
      options!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(options!.signal!.reason); }, { once: true });
    });
    return response({});
  }) as typeof fetch });
  await assert.rejects(timed.detail(smartRecruitersListing(posting(), 'Canva')!), { name: 'TimeoutError' });
});
