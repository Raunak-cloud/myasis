import type { Page } from 'patchright';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';
import type { ApplyDeps } from './agent/apply-agent.js';
import { applyToJobWithAgent } from './agent/apply-agent.js';
import { applyToIndeedJob } from './apply-indeed.js';
import { fetchJobDetail } from './discovery.js';
import { fetchJobDetailViaPanel as fetchIndeedDetail } from './discovery-indeed.js';
import { identifyDirectJob } from './direct-external.js';
import { guardExternalNavigations } from './external-url.js';
import { jobBoardForUrl } from './job-board-url.js';
import { adzunaConfigured } from './adzuna-config.js';
import { adzunaListing } from './adzuna.js';
import { resolveAdzunaRedirect } from './adzuna-redirect.js';
import { config } from './config.js';
import { outsideScope, scopeSkipReason } from './run-scope.js';
import { refreshMatchedApplication } from './matched-application.js';
import { runApplicationAgent } from './agent/loop.js';
import { outcomeFromRun } from './agent/outcome.js';

export async function fetchAdzunaDetail(page: Page, stub: JobListing,
  options: { resolve?: typeof resolveAdzunaRedirect } = {}): Promise<JobListing> {
  const source = stub.listingSourceUrl ?? stub.url;
  const checked = adzunaListing({ id: stub.id.replace(/^adzuna-/, ''), title: stub.title, redirect_url: source });
  if (stub.platform !== 'adzuna' || checked?.id !== stub.id) throw new Error('Invalid Adzuna listing identity.');
  // Resolve the tracking hop first, then let the existing browser and board
  // adapters read the full vacancy with the account's normal session.
  const vacancy=await(options.resolve??resolveAdzunaRedirect)(checked.url);
  const guard = await guardExternalNavigations(page.context(), { allowJobBoards: true });
  try {
    await page.goto(vacancy, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => Boolean(document.body?.innerText.trim()), undefined, { timeout: 10000 }).catch(() => {});
    const destination = page.url();
    const board = jobBoardForUrl(destination);
    let detail: JobListing;
    if (board === 'seek') {
      detail = await fetchJobDetail(page, { ...stub, ageDays:undefined,listedAt:undefined,applicationUrl: undefined, url: destination });
    } else if (board === 'indeed') {
      const key = new URL(destination).searchParams.get('jk') ?? new URL(destination).searchParams.get('vjk');
      if (!key || !/^[a-f0-9]{16}$/i.test(key)) throw new Error('Adzuna did not resolve to an Indeed vacancy.');
      detail = await fetchIndeedDetail(page, { ...stub, teaser: undefined, applicationUrl: undefined, id: key, url: destination });
    } else {
      const identity = await identifyDirectJob(page);
      detail = { ...stub, ...identity, company: identity.company === new URL(destination).hostname ? stub.company : identity.company,
        location: identity.location || stub.location, applicationMode: 'external', applicationUrl: destination };
    }
      // Aggregators can discover an old advertisement recently. Prefer an
      // original posting date when the employer publishes one.
      const originalDate=await page.evaluate(()=>{
        const pending:unknown[]=[];
        for(const script of document.querySelectorAll('script[type="application/ld+json"]')){
          try{pending.push(JSON.parse(script.textContent??'null'));}catch{/* Not job metadata. */}
        }
        while(pending.length){
          const value=pending.shift();
          if(Array.isArray(value)){pending.push(...value);continue;}
          if(!value||typeof value!=='object')continue;
          const item=value as Record<string,unknown>;
          const types=Array.isArray(item['@type'])?item['@type']:[item['@type']];
          if(types.includes('JobPosting')&&typeof item.datePosted==='string')return item.datePosted;
          if(Array.isArray(item['@graph']))pending.push(...item['@graph']);
        }
        return null;
      });
      if(originalDate&&Number.isFinite(Date.parse(originalDate))){
        detail.listedAt=new Date(originalDate).toISOString();
        detail.ageDays=Math.max(0,Math.floor((Date.now()-Date.parse(originalDate))/86400000));
      }
    if (!detail.description?.trim()) throw new Error('The full Adzuna vacancy could not be read.');
    return { ...detail, id: stub.id, platform: 'adzuna', source: stub.source, listingSourceUrl: checked.url,
      ageDays:detail.ageDays??stub.ageDays,listedAt:detail.listedAt??stub.listedAt,
      url: destination, applicationUrl: detail.applicationUrl ?? destination };
  } finally { await guard.stop(); }
}

export async function applyToAdzunaJob(page: Page, job: JobListing, profile: CandidateProfile, deps: ApplyDeps,
  options: { runAgent?: typeof runApplicationAgent; fetchDetail?: typeof fetchAdzunaDetail } = {}): Promise<ApplyOutcome> {
  if (!adzunaConfigured()) return { status: 'skipped', jobId: job.id, reason: 'Adzuna is currently unavailable.' };
  const board = jobBoardForUrl(job.url);
  if (board === 'seek') return applyToJobWithAgent(page, job, profile, deps);
  if (board === 'indeed') return applyToIndeedJob(page, job, profile, deps);
  if (!config.allowExternalApply) return { status: 'off-platform', jobId: job.id, redirectedTo: job.applicationUrl ?? job.url };
  if (outsideScope('external')) return { status: 'skipped', jobId: job.id, reason: scopeSkipReason() };
  if (config.dryRun && process.env.REHEARSE !== 'true') return { status: 'skipped', jobId: job.id, reason: 'Dry run — forms are not opened.' };
  const refreshed = await refreshMatchedApplication(job, await(options.fetchDetail??fetchAdzunaDetail)(page, job), profile);
  if ('outcome' in refreshed) return refreshed.outcome;
  delete job.fitReview; Object.assign(job, refreshed.job);
  // A changed redirect may now target a board; its existing adapter owns that flow.
  if (jobBoardForUrl(job.url) === 'seek') return applyToJobWithAgent(page, job, profile, deps);
  if (jobBoardForUrl(job.url) === 'indeed') return applyToIndeedJob(page, job, profile, deps);
  const before = new Set(page.context().pages());
  const guard = await guardExternalNavigations(page.context());
  try {
    await page.goto(job.applicationUrl ?? job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const run = await (options.runAgent ?? runApplicationAgent)({ page, job, profile, log: line => console.log(line) });
    return outcomeFromRun(run, job.id, page.url(), deps.onFriction);
  } finally {
    for (const tab of page.context().pages()) if (tab !== page && !before.has(tab)) await tab.close().catch(() => {});
    await guard.stop();
  }
}
