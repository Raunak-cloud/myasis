import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

const dir = mkdtempSync(join(tmpdir(), 'owtomate-adzuna-'));
process.env.DATA_DIR = dir;
process.env.ADZUNA_ENABLED = 'true'; process.env.ADZUNA_APP_ID = 'fixture-id'; process.env.ADZUNA_APP_KEY = 'fixture-secret';
process.env.CELERIS_API_KEY = 'fixture-only'; process.env.ALLOW_EXTERNAL_APPLY = 'true'; process.env.DRY_RUN = 'false';
process.env.MAX_AGE_DAYS='10';
const { adzunaListing } = await import('./adzuna.js');
const { fetchAdzunaDetail, applyToAdzunaJob } = await import('./adzuna-browser.js');
const { config } = await import('./config.js');
const { reviewContentFingerprint, reviewContextFingerprint } = await import('./review-cache.js');
const { reviewDuplicate } = await import('./duplicate-review.js');
const { assertExternalJobUrl } = await import('./external-url.js');
const { assertExternalNavigationUrl } = await import('./external-url.js');
const { resolveAdzunaRedirect } = await import('./adzuna-redirect.js');
const {deterministicExclusion}=await import('./scoring.js');

test('browser resolves Adzuna tracking, reads full employer evidence, preserves attribution and uses the existing agent', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const context = await browser.newContext(); const page = await context.newPage(); let destination = 'https://example.com/jobs/87108';
    let postedDaysAgo=2;
    let trackingRequests=0;
    const resolve=(source:string)=>resolveAdzunaRedirect(source,{
      fetch:async()=>{trackingRequests++;return new Response(null,{status:302,headers:{location:destination}});},
      validate:url=>assertExternalNavigationUrl(url,async host=>host!=='127.0.0.1',true),
    });
    const detailReader:typeof fetchAdzunaDetail=(page,job)=>fetchAdzunaDetail(page,job,{resolve});
    let outsideRequests = 0;
    // Every request is fulfilled or refused locally; no employer receives data.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'www.adzuna.com.au') return route.fulfill({ status: 302, headers: { location: destination } });
      if (url.hostname === 'example.com') return route.fulfill({ contentType: 'text/html', body: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Senior Data Analyst',datePosted:new Date(Date.now()-postedDaysAgo*86400000).toISOString(), hiringOrganization: { name: 'Example Employer' }, jobLocation: { address: { addressLocality: 'Sydney' } }, description: 'Full employer description: analyse operational data and build SQL reports.' })}</script><main><h1>Senior Data Analyst</h1><p>Full employer description: analyse operational data and build SQL reports.</p><button>Apply</button></main>` });
      if (url.hostname === 'www.seek.com.au') return route.fulfill({ contentType: 'text/html', body: '<main><h1>Senior Data Analyst</h1><div data-automation="jobAdDetails">Full SEEK description: analyse operational data and build SQL reports.</div><span data-automation="job-detail-salary">$140,000</span><span data-automation="job-detail-date">20 days ago</span><span data-automation="job-detail-location">Sydney</span><span data-automation="job-detail-work-type">Hybrid</span><a data-automation="job-detail-apply" href="/job/95593975/apply">Quick apply</a></main>' });
      if (url.hostname === 'au.indeed.com') return route.fulfill({ contentType:'text/html',body:`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',datePosted:new Date(Date.now()-3*86400000).toISOString()})}</script><main><h1>Senior Data Analyst</h1><div id="jobDescriptionText">Full Indeed description: SQL reporting for a hybrid Sydney team.</div><span data-testid="inlineHeader-companyLocation">Sydney</span><button data-testid="primary-apply-action">Apply now</button></main>` });
      outsideRequests++; return route.abort();
    });
    const stub = adzunaListing({ id: '123', title: 'Senior Data Analyst', company: { display_name: 'Example Employer' },
      redirect_url: 'https://www.adzuna.com.au/jobs/land/ad/123?utm_source=fixture',created:new Date().toISOString(), description: 'Truncated summary.' })!;
    const detail = await detailReader(page, stub);
    assert.equal(detail.id, stub.id); assert.equal(detail.platform, 'adzuna'); assert.equal(detail.url, destination);
    assert.equal(detail.applicationUrl, destination); assert.equal(detail.listingSourceUrl, stub.url);
    assert.match(detail.description!, /^Full employer description/); assert.doesNotMatch(detail.description!, /Truncated/);
    assert.equal(detail.applicationMode, 'external');
    assert.equal(detail.ageDays,2,'The original employer date wins over a newly discovered aggregate.');
    const profile = { name: 'Fixture Candidate', email: 'fixture@example.test', skills: ['SQL'], excludedDomains: [] } as unknown as import('./types.js').CandidateProfile;
    detail.fitReview = { score: 90, reason: 'Fixture evidence matches', evidence: ['SQL reports'],
      contentFingerprint: reviewContentFingerprint(detail)!, contextFingerprint: reviewContextFingerprint(profile) };
    let runs = 0;
    const result = await applyToAdzunaJob(page, detail, profile, { onFriction: () => {} }, { fetchDetail:detailReader,runAgent: async options => {
      runs++; assert.equal(options.job.id, stub.id); assert.equal(options.page.url(), destination);
      return { outcome: { status: 'applied', confirmation: 'Your application has been sent.' }, captured: [], actions: [],
        submitPressed: true, steps: 1, usage: 'fixture only' } as import('./agent/loop.js').AgentRunResult;
    } });
    assert.equal(result.status, 'applied'); assert.equal(runs, 1);
    assert.equal(reviewDuplicate(detail, [{ jobId: 'other-source-id', platform: 'external', url: destination,
      title: detail.title, company: detail.company, location: detail.location, appliedAt: '2026-11-07', score: 90, scoreReasons: [] }]).decision, 'duplicate');
    config.dryRun = true;
    assert.equal((await applyToAdzunaJob(page, detail, profile, { onFriction: () => {} })).status, 'skipped');
    config.dryRun = false;
    postedDaysAgo=20;
    const old=await detailReader(page,stub);
    assert.equal(old.ageDays,20);assert.match(deterministicExclusion(old)!,/>10d/,'An old repost remains outside the saved age preference.');
    postedDaysAgo=2;

    destination = 'https://www.seek.com.au/job/95593975';
    const mirror = await detailReader(page, stub);
    assert.equal(mirror.platform, 'adzuna'); assert.equal(mirror.id, stub.id); assert.equal(mirror.applicationMode, 'hosted');
    assert.match(mirror.description!, /^Full SEEK description/);
    assert.equal(mirror.applicationUrl, 'https://www.seek.com.au/job/95593975/apply');
    assert.equal(mirror.ageDays,20,'The board posting age also wins over the new aggregator card.');
    // Boards are permitted only for this aggregator's existing-board handoff.
    await assert.rejects(assertExternalJobUrl(destination, async () => true), /cannot target/);
    assert.equal(await assertExternalJobUrl(destination, async () => true, true), destination);

    destination='https://au.indeed.com/viewjob?jk=0123456789abcdef';
    const indeed=await detailReader(page,stub);
    assert.equal(indeed.id,stub.id);assert.equal(indeed.platform,'adzuna');
    assert.equal(indeed.url,destination);assert.equal(indeed.applicationMode,'hosted');
    assert.match(indeed.description!,/^Full Indeed description/);
    assert.equal(indeed.ageDays,3);assert.equal(new URL(page.url()).searchParams.get('vjk'),'0123456789abcdef');
    assert.equal(reviewDuplicate(indeed,[{jobId:'0123456789abcdef',platform:'indeed',url:destination,title:indeed.title,company:indeed.company,location:indeed.location,appliedAt:'2026-11-07',score:90,scoreReasons:[]}]).decision,'duplicate');

    destination = 'https://127.0.0.1/private';
    await assert.rejects(detailReader(page, stub));
    assert.equal(outsideRequests, 0, 'Private redirects and unknown requests never leave the isolated fixture.');
    assert.equal(trackingRequests,6,'Discovery and refresh retain the Adzuna tracking hop.');
    await assert.rejects(fetchAdzunaDetail(page, { ...stub, listingSourceUrl: 'https://example.com/forged' }), /Invalid Adzuna listing/);
  } finally { await browser.close(); rmSync(dir, { recursive: true, force: true }); }
});
