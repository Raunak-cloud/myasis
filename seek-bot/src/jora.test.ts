import test from 'node:test';
import assert from 'node:assert/strict';
import { joraPosting, joraSearchUrl, parseJoraSearch, parseJoraDetail } from './jora.js';
import { sameApplication, applicationKeys } from './application-identity.js';
import { enabledPlatforms } from './platforms.js';
import type { AppliedRecord, JobListing } from './types.js';

const hash = '3aeecd50c4575d37565ae11fcbb7929a';
const path = `/job/Data-Analyst-${hash}`;
const doc = (body: string) => `<html><body>${body}</body></html>`;
const card = `<div data-job-card="true"><h2><a class="job-link" href="${path}?tracking=one">Data Analyst</a><a class="job-link" href="${path}">Data Analyst</a></h2>
<span class="job-company">Example employer</span><a class="job-location">Sydney NSW</a>
<div class="badge">Hybrid</div><span>$85,000 - $95,000 a year</span><div class="job-abstract">Analyse data.</div><span class="job-listed-date">Posted 5d ago</span></div>`;
const stub = () => parseJoraSearch(doc(`<div id="jobresults">${card}</div>`))[0];
const record = (job: JobListing): AppliedRecord => ({ jobId: job.id, platform: job.platform!, url: job.url,
  applicationUrl: job.applicationUrl, title: job.title, company: job.company, location: job.location, appliedAt: '2026-11-15', score: 90 });

test('Jora is selectable only when explicitly opted in; defaults stay SEEK', () => {
  assert.deepEqual(enabledPlatforms('', false, false).map(board => board.id), ['seek']);
  assert.deepEqual(enabledPlatforms('seek,indeed', false, false).map(board => board.id), ['seek', 'indeed']);
  assert.deepEqual(enabledPlatforms('jora', false, false).map(board => board.id), ['jora']);
});

test('search preserves query/location, sorts newest first and rounds transport age up', () => {
  const scope = { location: 'Sydney NSW', radiusKm: 25, arrangements: ['hybrid' as const], label: 'Sydney' };
  const before = JSON.stringify(scope), url = new URL(joraSearchUrl('Data & Analytics', 2, 10, scope));
  assert.equal(url.searchParams.get('q'), 'Data & Analytics'); assert.equal(url.searchParams.get('l'), 'Sydney NSW');
  assert.equal(url.searchParams.get('p'), '2'); assert.equal(url.searchParams.get('a'), '14d'); assert.equal(url.searchParams.get('st'), 'date');
  assert.equal(JSON.stringify(scope), before);
  assert.equal(new URL(joraSearchUrl('x', 1, 31)).searchParams.has('a'), false);
  assert.equal(new URL(joraSearchUrl('x', 1, 1)).searchParams.get('a'), '1d');
  assert.equal(new URL(joraSearchUrl('x', 1, 20)).searchParams.get('l'), 'Australia');
  for (const page of [0, -1, 1.2, Infinity]) assert.throws(() => joraSearchUrl('x', page, 10), /Invalid/);
});

test('posting identity rejects spoofed hosts, credentials, redirects and malformed IDs', () => {
  assert.deepEqual(joraPosting(`${path}?tracking=two`), { id: `jora-${hash}`, url: `https://au.jora.com${path}` });
  for (const input of [`https://au.jora.com.evil.invalid${path}`, `https://x@au.jora.com${path}`, `/job/rd/${hash}`, '/job/unknown', `http://au.jora.com${path}`, 'javascript:alert(1)']) assert.equal(joraPosting(input), null);
});

test('observed result cards deduplicate desktop/mobile copies and preserve listing facts', () => {
  const jobs = parseJoraSearch(doc(`<div id="jobresults">${card}${card}</div>`));
  assert.equal(jobs.length, 1); const job = jobs[0];
  assert.equal(job.id, `jora-${hash}`); assert.equal(job.company, 'Example employer'); assert.equal(job.location, 'Sydney NSW');
  assert.equal(job.ageDays, 5); assert.equal(job.salary, '$85,000 - $95,000 a year'); assert.equal(job.workArrangement, 'Hybrid');
  assert.equal(job.applicationMode, 'unknown'); assert.equal(job.listingSourceUrl, `https://au.jora.com${path}`);
});

test('empty, blocked and changed layouts are distinguished rather than silently returning no jobs', () => {
  assert.deepEqual(parseJoraSearch(doc('<h1>0 jobs – obscure keyword</h1>')), []);
  for (const text of ['Verify you are human', 'Just a moment...', 'Access denied', 'captcha']) assert.throws(() => parseJoraSearch(doc(`<div id="jobresults">${text}</div>`)), /verification/);
  for (const body of ['<h1>Search jobs</h1>', '<div id="jobresults"><div data-job-card="true">unreadable card</div></div>']) assert.throws(() => parseJoraSearch(doc(body)), /could not be read|without readable/);
});

test('detail accepts only this vacancy outbound link and extracts full visible description', () => {
  const html = doc(`<div id="job-view"><h1 class="job-title">Data Analyst</h1><div id="company-location-container"><span class="company">Employer</span><span class="location">Sydney CBD</span></div>
  <div id="job-meta"><span class="listed-date">2d ago</span></div><div id="job-description-container"><p>Full description.</p><p>SQL experience.</p></div><a class="apply-button" href="/job/rd/${hash}?sp=viewjob">Apply on company site</a></div>`);
  const result = parseJoraDetail(html, stub());
  assert.equal(result.job.description, 'Full description. SQL experience.'); assert.equal(result.job.ageDays, 2); assert.equal(result.job.company, 'Employer');
  assert.equal(new URL(result.redirect).pathname, `/job/rd/${hash}`);
  assert.throws(() => parseJoraDetail(html.replace(`/rd/${hash}`, '/rd/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), stub()), /does not identify/);
  assert.throws(() => parseJoraDetail(html.replace(`/job/rd/${hash}`, 'https://evil.invalid/job'), stub()), /does not identify/);
  assert.throws(() => parseJoraDetail(html, { ...stub(), id: 'jora-wrong' }), /identity/);
});

test('Jora/native SEEK duplicates work in both directions across referral hosts', () => {
  const native: JobListing = { ...stub(), platform: 'seek', id: '95787949', url: 'https://www.seek.com.au/job/95787949' };
  const mirror = { ...stub(), url: 'https://au.seek.com/job/95787949?utm_source=joraau&tracking=referral' };
  assert.equal(sameApplication(record(native), mirror), true); assert.equal(sameApplication(record(mirror), native), true);
  assert.ok(applicationKeys(mirror).includes('listing:seek:95787949'));
  assert.equal(sameApplication(record(mirror), { ...native, id: '95787950', url: native.url.replace('95787949', '95787950') }), false);
  assert.equal(sameApplication(record(mirror), { ...mirror, id: 'jora-another' }), true);
});

test('Jora mirrors Indeed or exact employer vacancies without blanket company/title blocking', () => {
  const native: JobListing = { ...stub(), platform: 'indeed', id: '0123456789abcdef', url: 'https://au.indeed.com/viewjob?jk=0123456789abcdef' };
  const mirror = { ...stub(), url: 'https://au.indeed.com/jobs?vjk=0123456789abcdef&utm_source=jora' };
  assert.equal(sameApplication(record(native), mirror), true); assert.equal(sameApplication(record(mirror), native), true);
  const employer = { ...stub(), platform: 'external' as const, id: 'external-one', url: 'https://careers.example.invalid/jobs/123?utm_source=seek' };
  assert.equal(sameApplication(record(employer), { ...stub(), url: employer.url.replace('seek', 'jora') }), true);
  assert.equal(sameApplication(record(employer), { ...stub(), url: employer.url.replace('/123', '/124') }), false);
  assert.equal(sameApplication(record(stub()), native), false, 'unresolved Jora stubs are not guessed to be duplicates');
});

test('concurrent Jora and native applications share the existing duplicate queue', async () => {
  process.env.CELERIS_API_KEY ||= 'fixture-only';
  const { DuplicateReviewQueue, reviewDuplicate } = await import('./duplicate-review.js');
  const native: JobListing = { ...stub(), platform: 'seek', id: '95787949', url: 'https://www.seek.com.au/job/95787949' };
  const mirror = { ...stub(), url: 'https://au.seek.com/job/95787949?utm_source=jora' };
  const queue = new DuplicateReviewQueue(), release = await queue.enter(native);
  let entered = false;
  const second = queue.enter(mirror).then(unlock => { entered = true; return unlock; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, false);
  release(); const unlock = await second;
  try {
    assert.equal(reviewDuplicate(mirror, [record(native)]).decision, 'duplicate');
    assert.equal(reviewDuplicate(mirror, []).decision, 'clear', 'other owners and unsuccessful attempts do not create applications');
    assert.equal(reviewDuplicate(native, [{ ...record(mirror), confirmationStatus: 'unconfirmed' }]).decision, 'duplicate');
  } finally { unlock(); }
});
