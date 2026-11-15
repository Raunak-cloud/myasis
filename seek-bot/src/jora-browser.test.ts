import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { parseJoraSearch } from './jora.js';

process.env.CELERIS_API_KEY ||= 'fixture-only';
const { searchJora, fetchJoraDetail } = await import('./jora-browser.js');
const hash = '3aeecd50c4575d37565ae11fcbb7929a';
const posting = `/job/Data-Analyst-${hash}`;
const html = (body: string) => `<html><body>${body}</body></html>`;
const results = html(`<div id="jobresults"><div data-job-card="true"><h2><a class="job-link" href="${posting}">Data Analyst</a></h2><span class="job-company">Fixture Employer</span><span class="job-location">Sydney</span><span class="job-listed-date">Posted 2d ago</span></div></div>`);
const detail = html(`<div id="job-view"><h1 class="job-title">Data Analyst</h1><div id="company-location-container"><span class="company">Fixture Employer</span></div><div id="job-description-container">Full Jora description for an Australian data role.</div><a class="apply-button" href="/job/rd/${hash}">Apply on company site</a></div>`);

test('real browser follows Jora handoffs to SEEK, Indeed and employer pages without submitting', async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
  const context = await browser.newContext();
  let destination = 'https://au.seek.com/job/95787949?utm_source=joraau', sourceStatus = 200;
  const methods: string[] = [], destinations: string[] = [], unexpected: string[] = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.resourceType() !== 'document') return route.abort();
    methods.push(request.method());
    if (url.hostname === 'au.jora.com') {
      if (url.pathname.startsWith('/job/rd/')) return route.fulfill({ contentType: 'text/html', body: html(`<script>location.replace(${JSON.stringify(destination)})</script>`) });
      return route.fulfill({ status: sourceStatus, contentType: 'text/html', body: url.pathname === '/j' ? results : detail });
    }
    destinations.push(url.href);
    if (['au.seek.com', 'www.seek.com.au'].includes(url.hostname)) return route.fulfill({ contentType: 'text/html', body: html(`<main><h1>Data Analyst</h1><div data-automation="jobAdDetails">Full SEEK description.</div><span data-automation="job-detail-date">Posted 5d ago</span><span data-automation="job-detail-location">Sydney</span><span data-automation="job-detail-salary">$100,000 a year</span><span data-automation="job-detail-work-type">Hybrid</span><a data-automation="job-detail-apply" href="/job/95787949/apply">Quick apply</a></main>`) });
    if (url.hostname.endsWith('indeed.com')) return route.fulfill({ contentType: 'text/html', body: html('<main data-testid="jobsearch-ViewjobPane"><div id="jobDescriptionText">Full Indeed description.</div><span data-testid="job-location">Sydney</span><button data-testid="primary-apply-action">Apply now</button></main>') });
    if (url.hostname === 'example.com') return route.fulfill({ contentType: 'text/html', body: html('<script type="application/ld+json">{"@type":"JobPosting","title":"Data Analyst","hiringOrganization":{"name":"Fixture Employer"},"description":"Full employer description.","jobLocation":{"address":{"addressLocality":"Sydney"}},"datePosted":"2026-11-01"}</script><main><h1>Data Analyst</h1>Full employer description.</main>') });
    unexpected.push(url.href); return route.abort();
  });
  try {
    const page = await context.newPage(); page.setDefaultTimeout(3000);
    const jobs = await searchJora(page, 'Data Analyst', 1);
    assert.equal(jobs.length, 1);
    const seek = await fetchJoraDetail(page, jobs[0]);
    assert.equal(seek.id, `jora-${hash}`); assert.equal(seek.platform, 'jora'); assert.equal(seek.description, 'Full SEEK description.'); assert.equal(seek.ageDays, 5);
    assert.equal(seek.listingSourceUrl, `https://au.jora.com${posting}`); assert.equal(new URL(seek.url).hostname, 'www.seek.com.au');
    assert.equal(new URL(seek.url).pathname, '/job/95787949'); assert.equal(new URL(seek.url).searchParams.get('utm_source'), 'joraau');
    destination = 'https://au.indeed.com/viewjob?jk=0123456789abcdef';
    const indeed = await fetchJoraDetail(page, jobs[0]);
    assert.equal(indeed.id, jobs[0].id); assert.equal(indeed.description, 'Full Indeed description.');
    assert.ok(destinations.some(url => new URL(url).searchParams.get('vjk') === '0123456789abcdef'), 'Indeed receives its native job key, never the Jora ID');
    destination = 'https://example.com/jobs/123';
    const employer = await fetchJoraDetail(page, jobs[0]);
    assert.equal(employer.company, 'Fixture Employer'); assert.equal(employer.description, 'Full employer description.'); assert.equal(employer.applicationMode, 'external');
    assert.equal(employer.applicationUrl, destination);
    assert.equal(employer.listedAt, '2026-11-01T00:00:00.000Z', 'original publication date wins over a recently aggregated listing');
    sourceStatus = 403;
    await assert.rejects(searchJora(page, 'Data Analyst', 2), /HTTP 403/);
    await assert.rejects(fetchJoraDetail(page, { ...parseJoraSearch(results)[0], id: 'wrong' }), /identity/);
    assert.ok(methods.length > 3); assert.ok(methods.every(method => method === 'GET')); assert.deepEqual(unexpected, []);
  } finally { await browser.close(); }
});
