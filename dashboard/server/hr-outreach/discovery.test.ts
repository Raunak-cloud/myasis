import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverHiringContact, publishedHiringContacts, createHiringContactSearch, canReuseHiringContact, type HiringContact } from './discovery.js';
import { PublicCrawler, type PageResponse } from '../job-index/network.js';

const now = new Date('2026-11-16T01:00:00.000Z');
const response = (url: string, text: string, status = 200): PageResponse => ({ url, text, status, type: 'text/html', retryAfter: null });
function fixture(pages: Record<string, string | PageResponse>) {
  const calls: string[] = [];
  return { calls, get: async (url: string) => { calls.push(url); const page = pages[url]; return typeof page === 'string' ? response(url, page) : page ?? response(url, '', 404); } };
}
const previous: HiringContact = { email: 'careers@acme.org', companyDomain: 'acme.org', kind: 'recruitment', sourceUrl: 'https://acme.org/careers', sourceText: 'Acme recruitment careers@acme.org', validatedAt: '2026-10-01T00:00:00Z' };

test('company careers pages precede search, select a published hiring contact, and retain source evidence', async () => {
  const crawler = fixture({
    'https://acme.org/': '<h1>Acme</h1><a href="/contact">Contact</a><a href="/careers">Careers</a>',
    'https://acme.org/careers': '<h1>Acme careers</h1><p>Contact our recruitment manager Jane Smith: <a href="mailto:jane.smith@acme.org?subject=Application">Jane Smith</a></p>',
  });
  const result = await discoverHiringContact({ company: 'Acme Pty Ltd', website: 'https://acme.org/' }, { crawler, now: () => now, search: async () => { throw Error('Should not search when official careers page works'); } });
  assert.equal(result.contact?.email, 'jane.smith@acme.org');
  assert.equal(result.contact?.kind, 'hiring_manager'); assert.equal(result.contact?.sourceUrl, 'https://acme.org/careers');
  assert.equal(result.contact?.validatedAt, now.toISOString()); assert.match(result.contact!.sourceText, /recruitment manager/);
  assert.deepEqual(crawler.calls, ['https://acme.org/', 'https://acme.org/careers']);
});

test('only visible published contacts are extracted; scripts, hidden traps and inappropriate mailboxes are ignored', () => {
  const html = `<h1>Acme careers</h1><script>recruitment evil@attacker.org</script><p hidden>Recruitment hidden@acme.org</p>
    <p style="display: none">Hiring invisible@acme.org</p><p>Recruitment privacy@acme.org support@acme.org no-reply@acme.org</p>
    <p>General enquiries info@acme.org</p><p>Recruitment: careers [at] acme [dot] org</p>`;
  const contacts = publishedHiringContacts(html, 'https://acme.org/', 'acme.org', true, now);
  assert.deepEqual(contacts.map(c => c.email), ['careers@acme.org']);
});

test('a recruiting header elsewhere does not promote a generic sales or support email', () => {
  const html = '<h1>Acme careers</h1><p>General enquiries info@acme.org</p><p>Support support@acme.org</p><a href="/careers">Careers</a>';
  assert.deepEqual(publishedHiringContacts(html, 'https://acme.org/', 'acme.org', true), []);
});

test('an explicit do-not-email notice disqualifies the published address', () => {
  for (const wording of ['Do not email careers@acme.org for recruitment.', 'Recruitment careers@acme.org, this mailbox is not monitored.', 'We do not accept emailed applications at careers@acme.org.']) {
    assert.deepEqual(publishedHiringContacts(`<p>${wording}</p>`, 'https://acme.org/', 'acme.org', true), [], wording);
  }
});

test('revalidation reads the exact previous source and refreshes timestamp without searching', async () => {
  const crawler = fixture({ 'https://acme.org/careers': '<h1>Acme</h1><p>Recruitment careers@acme.org</p>' });
  const result = await discoverHiringContact({ company: 'Acme', previous }, { crawler, now: () => now, search: async () => { throw Error('Unexpected search'); } });
  assert.equal(result.contact?.email, previous.email); assert.equal(result.contact?.validatedAt, now.toISOString());
  assert.match(result.reason, /revalidated/); assert.deepEqual(crawler.calls, [previous.sourceUrl]);
});

test('a removed cached email is never reused and fresh public evidence can replace it', async () => {
  const crawler = fixture({
    'https://acme.org/careers': '<h1>Acme</h1><p>This contact has moved.</p>',
    'https://acme.org/': '<h1>Acme</h1><a href="/people">Our people</a>',
    'https://acme.org/people': '<h1>Acme</h1><p>Hiring enquiries: talent@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/', previous }, { crawler });
  assert.equal(result.contact?.email, 'talent@acme.org'); assert.notEqual(result.contact?.email, previous.email);
});

test('unreachable revalidation with no fresh publication returns no contact, never a stale fallback', async () => {
  const result = await discoverHiringContact({ company: 'Acme', previous }, { crawler: fixture({}) });
  assert.equal(result.contact, null);
});

test('a replacement contact published on the cached source is adopted instead of retaining a removed address', async () => {
  const result = await discoverHiringContact({ company: 'Acme', previous }, { crawler: fixture({ 'https://acme.org/careers': '<h1>Acme</h1><p>Recruitment talent@acme.org</p>' }) });
  assert.equal(result.contact?.email, 'talent@acme.org'); assert.equal(result.pagesRead, 1);
});

test('cached domain must still identify the company when revalidated', async () => {
  const result = await discoverHiringContact({ company: 'Acme', previous }, { crawler: fixture({ 'https://acme.org/careers': '<h1>Unrelated company</h1><p>Recruitment careers@acme.org</p>' }) });
  assert.equal(result.contact, null);
});

test('external cached publications cannot renew a contact after the email company domain changes ownership', async () => {
  const external = { ...previous, sourceUrl: 'https://directory.org/acme' };
  const crawler = fixture({
    'https://directory.org/acme': '<h1>Acme recruitment</h1><p>Recruitment careers@acme.org</p>',
    'https://acme.org/': '<h1>Different company</h1><p>Recruitment careers@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', previous: external }, { crawler });
  assert.equal(result.contact, null); assert.equal(result.retryable, false);
  assert.deepEqual(crawler.calls, ['https://directory.org/acme', 'https://acme.org/']);
});

test('external cached contacts renew only while their official company publisher still confirms identity', async () => {
  const external = { ...previous, sourceUrl: 'https://directory.org/acme' };
  const crawler = fixture({
    'https://directory.org/acme': '<h1>Acme recruitment</h1><p>Recruitment careers@acme.org</p>',
    'https://acme.org/': '<h1>Acme</h1><p>Welcome to our company website.</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', previous: external }, { crawler, now: () => now });
  assert.equal(result.contact?.email, previous.email); assert.equal(result.contact?.validatedAt, now.toISOString());
  assert.equal(result.retryable, false); assert.equal(result.pagesRead, 2);
});

test('temporary official publisher outages cannot renew a directory contact and remain retryable', async () => {
  const external = { ...previous, sourceUrl: 'https://directory.org/acme' };
  const crawler = fixture({
    'https://directory.org/acme': '<h1>Acme recruitment</h1><p>Recruitment careers@acme.org</p>',
    'https://acme.org/': response('https://acme.org/', '', 503),
  });
  const result = await discoverHiringContact({ company: 'Acme', previous: external }, { crawler });
  assert.equal(result.contact, null); assert.equal(result.retryable, true);
});

test('ATS and job-board emails are never treated as the employer contact; outbound employer links are followed', async () => {
  const crawler = fixture({
    'https://www.seek.com.au/job/123': '<h1>Acme vacancy</h1><p>Recruitment careers@seek.com.au</p><a href="https://acme.org/">Acme company website</a>',
    'https://acme.org/': '<h1>Acme</h1><p>Recruitment careers@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', jobUrl: 'https://www.seek.com.au/job/123' }, { crawler });
  assert.equal(result.contact?.email, 'careers@acme.org'); assert.equal(result.contact?.companyDomain, 'acme.org');
});

test('official website discovery verifies page identity rather than trusting search snippets or guesses', async () => {
  const crawler = fixture({
    'https://unrelated.org/': '<h1>Other company</h1><p>Recruitment careers@unrelated.org</p>',
    'https://acme.org/': '<h1>Acme</h1><p>Recruitment careers@acme.org</p>',
  });
  const queries: string[] = [];
  const result = await discoverHiringContact({ company: 'Acme' }, { crawler, search: async query => { queries.push(query); return [{ url: 'https://unrelated.org/', title: 'Acme careers' }, { url: 'https://acme.org/' }]; } });
  assert.equal(result.contact?.email, 'careers@acme.org'); assert.equal(queries.length, 1);
});

test('a public ATS job contact can be used after the company domain is independently confirmed', async () => {
  const crawler = fixture({
    'https://acme.org/': '<h1>Acme</h1><p>We have great opportunities.</p>',
    'https://careers.pageuppeople.com/123/job/1': '<h1>Acme careers</h1><p>Hiring manager Jane: jane@acme.org</p><p>Platform support careers@pageuppeople.com</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/', jobUrl: 'https://careers.pageuppeople.com/123/job/1' }, { crawler });
  assert.equal(result.contact?.email, 'jane@acme.org'); assert.equal(result.contact?.sourceUrl, 'https://careers.pageuppeople.com/123/job/1');
  assert.deepEqual(crawler.calls, ['https://acme.org/', 'https://careers.pageuppeople.com/123/job/1']);
});

test('external public sources require company identity plus a company-domain email', async () => {
  const crawler = fixture({
    'https://acme.org/': '<h1>Acme</h1><p>We are a local company.</p>',
    'https://directory.org/acme': '<h1>Acme recruitment</h1><p>Contact recruitment: wrong@attacker.org careers@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler, search: async query => query.includes('"@acme.org"') ? [{ url: 'https://directory.org/acme' }] : [] });
  assert.equal(result.contact?.email, 'careers@acme.org'); assert.equal(result.contact?.sourceUrl, 'https://directory.org/acme');
});

test('private URLs and private redirect destinations cannot be returned as verified contacts', async () => {
  const crawler = fixture({ 'https://acme.org/': response('https://127.0.0.1/private', '<h1>Acme</h1><p>Recruitment careers@acme.org</p>') });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler });
  assert.equal(result.contact, null);
  await discoverHiringContact({ company: 'Acme', website: 'https://169.254.169.254/' }, { crawler });
  assert.equal(crawler.calls.some(url => url.includes('169.254')), false);
});

test('real crawler enforces robots and pins redirected destination policy before discovery reads', async () => {
  const calls: string[] = [];
  const crawler = new PublicCrawler(async url => { calls.push(url); return response(url, url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /' : '<h1>Acme</h1><p>Recruitment careers@acme.org</p>'); });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler });
  assert.equal(result.contact, null); assert.deepEqual(calls, ['https://acme.org/robots.txt']);
});

test('page budget bounds cyclic careers links and errors do not become invented contacts', async () => {
  const crawler = fixture({
    'https://acme.org/': '<h1>Acme</h1><a href="/careers">Careers</a><a href="/people">People</a>',
    'https://acme.org/careers': '<h1>Acme</h1><a href="/">Home</a><a href="/team">Team</a>',
  });
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler, maxPages: 2 });
  assert.equal(result.contact, null); assert.equal(result.pagesRead, 2); assert.equal(crawler.calls.length, 2);
});

test('caller cancellation is preserved rather than reported as no contact', async () => {
  const controller = new AbortController(); controller.abort(Error('Run cancelled'));
  await assert.rejects(discoverHiringContact({ company: 'Acme', website: 'https://acme.org/', signal: controller.signal }, { crawler: fixture({}) }), /Run cancelled/);
});

test('search uses global reservation, provider key only in headers, bounded results and no redirects', async () => {
  let reservations = 0, requests = 0;
  const network: typeof fetch = async (input, init) => {
    requests++; const url = new URL(String(input)); assert.equal(url.hostname, 'api.search.brave.com'); assert.equal(url.searchParams.get('count'), '6');
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('X-Subscription-Token'), 'fixture-secret');
    assert.equal(url.href.includes('fixture-secret'), false);
    return Response.json({ web: { results: [{ url: 'https://acme.org/' }] } });
  };
  const search = createHiringContactSearch({ key: 'fixture-secret', reserveSearch: async () => ++reservations === 1, network });
  assert.equal((await search('Acme careers')).length, 1); await assert.rejects(search('Acme contacts'), /deferred/); assert.equal(requests, 1);
});

test('company mentions on a public directory cannot establish the official company domain', async () => {
  const crawler = fixture({
    'https://directory.org/acme': '<title>Acme careers directory</title><h1>Acme</h1><p>Recruitment careers@directory.org</p>',
    'https://acme.org/': '<h1>Acme</h1><p>Recruitment careers@acme.org</p>',
  });
  const result = await discoverHiringContact({ company: 'Acme' }, { crawler, search: async () => [{ url: 'https://directory.org/acme', title: 'Acme official careers' }, { url: 'https://acme.org/' }] });
  assert.equal(result.contact?.companyDomain, 'acme.org'); assert.equal(result.contact?.email, 'careers@acme.org'); assert.equal(result.retryable, false);
});

test('publisher site identity supports a genuine brand whose website uses a different domain', async () => {
  const crawler = fixture({ 'https://brandportal.org/': '<meta property="og:site_name" content="Acme"><h1>Acme</h1><p>Recruitment careers@brandportal.org</p>' });
  const result = await discoverHiringContact({ company: 'Acme' }, { crawler, search: async () => [{ url: 'https://brandportal.org/' }] });
  assert.equal(result.contact?.companyDomain, 'brandportal.org');
});

test('transport failures, provider outages, HTTP rate limits and exhausted search allowances remain retryable', async () => {
  for (const status of [408, 429, 503]) {
    const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler: fixture({ 'https://acme.org/': response('https://acme.org/', '', status) }) });
    assert.equal(result.contact, null); assert.equal(result.retryable, true, `HTTP ${status}`);
  }
  const search = createHiringContactSearch({ key: 'fixture', reserveSearch: async () => false });
  const budget = await discoverHiringContact({ company: 'Acme' }, { crawler: fixture({}), search });
  assert.equal(budget.retryable, true);
  const transport = await discoverHiringContact({ company: 'Acme', previous }, { crawler: { get: async () => { throw Error('Temporary DNS outage'); } } });
  assert.equal(transport.contact, null); assert.equal(transport.retryable, true);
});

test('confirmed missing or non-published contacts produce a clean negative result', async () => {
  const result = await discoverHiringContact({ company: 'Acme', website: 'https://acme.org/' }, { crawler: fixture({ 'https://acme.org/': '<h1>Acme</h1><p>Visit our offices.</p>' }) });
  assert.equal(result.contact, null); assert.equal(result.retryable, false);
  const removed = await discoverHiringContact({ company: 'Acme', previous }, { crawler: fixture({}) });
  assert.equal(removed.contact, null); assert.equal(removed.retryable, false, 'HTTP404 confirms the old publication was removed');
});

test('fresh cached contacts can be reused for direct employer sites without new discovery', async () => {
  const crawler = fixture({});
  assert.equal(await canReuseHiringContact('Acme', 'https://careers.acme.org/job/123', previous, { crawler }), true);
  assert.deepEqual(crawler.calls, []);
  assert.equal(await canReuseHiringContact('Acme', 'https://other-acme.org/job/123', previous, { crawler }), false);
});

test('job-board employer names alone cannot authorize a same-name company cache', async () => {
  const url = 'https://www.seek.com.au/job/123';
  const crawler = fixture({ [url]: '<h1>Acme hiring</h1><p>Acme is a great place to work. Recruitment careers@differentacme.org</p>' });
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler }), false);
});

test('public job organisation metadata associates a vacancy with the verified cached domain', async () => {
  const url = 'https://www.seek.com.au/job/123';
  const crawler = fixture({ [url]: `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'JobPosting', hiringOrganization: { '@type': 'Organization', name: 'Acme Pty Ltd', sameAs: 'https://www.acme.org/' } }] })}</script>` });
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler }), true);
  assert.equal(await canReuseHiringContact('Other Acme', url, previous, { crawler }), false);
});

test('explicit company website links associate an ATS vacancy with the cached domain', async () => {
  const url = 'https://acme.wd3.myworkdayjobs.com/jobs/job/1';
  const crawler = fixture({ [url]: '<h1>Acme careers</h1><a href="https://www.acme.org/">Company website</a>' });
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler }), true);
  const unrelatedLink = fixture({ [url]: '<h1>Acme careers</h1><a href="https://www.acme.org/">Privacy policy vendor</a>' });
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler: unrelatedLink }), false);
});

test('an explicitly published current-vacancy recruitment contact corroborates the cache identity', async () => {
  const url = 'https://www.seek.com.au/job/123';
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler: fixture({ [url]: '<h1>Acme careers</h1><p>Recruitment careers@acme.org</p>' }) }), true);
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler: fixture({ [url]: '<h1>Acme careers</h1><p>Recruitment careers@differentacme.org</p>' }) }), false);
});

test('cache identity checks reject private URLs and inaccessible or private redirects', async () => {
  assert.equal(await canReuseHiringContact('Acme', 'https://127.0.0.1/job/1', previous, { crawler: fixture({}) }), false);
  const url = 'https://www.seek.com.au/job/123';
  assert.equal(await canReuseHiringContact('Acme', url, previous, { crawler: fixture({ [url]: response('https://127.0.0.1/', '', 200) }) }), false);
});
