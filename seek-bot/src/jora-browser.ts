import type { Page } from 'patchright';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';
import { applyToJobWithAgent, type ApplyDeps } from './agent/apply-agent.js';
import { applyToIndeedJob } from './apply-indeed.js';
import { fetchJobDetail } from './discovery.js';
import { fetchJobDetailViaPanel as fetchIndeedDetail } from './discovery-indeed.js';
import { identifyDirectJob } from './direct-external.js';
import { guardExternalNavigations } from './external-url.js';
import { jobBoardForUrl } from './job-board-url.js';
import { config } from './config.js';
import { outsideScope, scopeSkipReason } from './run-scope.js';
import { runApplicationAgent } from './agent/loop.js';
import { outcomeFromRun } from './agent/outcome.js';
import { waitForChallengeToClear } from './browser.js';
import { browserDeadline, browserOperationTimeout, assertBrowserOperationActive } from './browser-deadline.js';
import type { DiscoverySearch } from './discovery-search.js';
import { joraSearchUrl, joraPosting, parseJoraSearch, parseJoraDetail } from './jora.js';
import {applicationModelEnvironment} from './application-model.js';

async function openJora(page: Page, url: string, ready: string, allowEmpty = false): Promise<void> {
  await browserDeadline('Open Jora page', 30_000, async () => {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: browserOperationTimeout() });
    if (response && response.status() >= 400) {
      const error = new Error(`Jora access failed (HTTP ${response.status()}).`);
      if ([403, 429].includes(response.status())) error.name = 'VerificationBlocked';
      throw error;
    }
    if (!await waitForChallengeToClear(page, browserOperationTimeout())) throw new Error('Jora security verification did not clear.');
    assertBrowserOperationActive();
    const content = page.locator(ready);
    const empty = page.getByText(/no jobs found|no matching jobs|0 jobs\b|could(?:n.t| not) find any jobs/i);
    await (allowEmpty ? content.or(empty) : content).first().waitFor({ state: 'attached', timeout: browserOperationTimeout() });
  });
}

export async function searchJora(page: Page, keyword: string, pageNum: number, scope?: DiscoverySearch): Promise<JobListing[]> {
  await openJora(page, joraSearchUrl(keyword, pageNum, config.rules.maxAgeDays, scope), '#jobresults', true);
  return parseJoraSearch(await page.content());
}

export async function fetchJoraDetail(page: Page, stub: JobListing): Promise<JobListing> {
  const source = joraPosting(stub.listingSourceUrl ?? stub.url);
  if (stub.platform !== 'jora' || source?.id !== stub.id) throw new Error('Invalid Jora listing identity.');
  const guard = await guardExternalNavigations(page.context(), { allowJobBoards: true });
  try {
    await openJora(page, source.url, '#job-view');
    const { job, redirect } = parseJoraDetail(await page.content(), stub);
    await browserDeadline('Open original Jora vacancy', 30_000, async () => {
      await page.goto(redirect, { waitUntil: 'domcontentloaded', timeout: browserOperationTimeout() });
      await page.waitForURL(url => url.hostname !== 'au.jora.com', { waitUntil: 'domcontentloaded', timeout: browserOperationTimeout() });
      if (!await waitForChallengeToClear(page, browserOperationTimeout())) throw new Error('The original vacancy requires security verification.');
      assertBrowserOperationActive();
      await page.locator('body').waitFor({ state: 'visible', timeout: browserOperationTimeout() });
    });
    let destination = page.url();
    const board = jobBoardForUrl(destination);
    if (new URL(destination).hostname.endsWith('jora.com')) throw new Error('Jora did not open the original vacancy.');
    let detail: JobListing;
    if (board === 'seek') {
      const id = new URL(destination).pathname.match(/^\/job\/(\d+)(?:\/|$)/)?.[1];
      if (!id) throw new Error('Jora did not resolve to a SEEK vacancy.');
      // Jora's au.seek.com referral is the same posting, but cookies belong
      // to SEEK's normal Australian host. Use the existing signed-in board.
      const native = new URL(`/job/${id}`, config.seekBase);
      native.search = new URL(destination).search;
      destination = native.href;
      detail = await fetchJobDetail(page, { ...job, id, url: destination, applicationUrl: undefined, ageDays: undefined, listedAt: undefined });
    } else if (board === 'indeed') {
      const url = new URL(destination), id = url.searchParams.get('jk') ?? url.searchParams.get('vjk');
      if (!id || !/^[a-f0-9]{16}$/i.test(id)) throw new Error('Jora did not resolve to an Indeed vacancy.');
      detail = await fetchIndeedDetail(page, { ...job, id, url: destination, teaser: undefined, applicationUrl: undefined, ageDays: undefined, listedAt: undefined });
    } else {
      const identity = await identifyDirectJob(page);
      // Some destinations initially render only a loading shell or portal
      // title. Keep the full Jora posting evidence rather than replacing it
      // with generic navigation copy. The applying agent reads the live form.
      const sameTitle = identity.title.toLowerCase().replace(/\W+/g, '') === job.title.toLowerCase().replace(/\W+/g, '');
      detail = { ...job, ...(sameTitle && identity.description.trim() ? identity : {}),
        company: !sameTitle || identity.company === new URL(destination).hostname ? job.company : identity.company,
        location: identity.location || job.location, applicationMode: 'external', applicationUrl: destination };
    }
    const published = await page.evaluate(() => {
      const queue: unknown[] = [];
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { queue.push(JSON.parse(node.textContent ?? 'null')); } catch { /* Other structured metadata. */ }
      }
      while (queue.length) {
        const value = queue.shift();
        if (Array.isArray(value)) { queue.push(...value); continue; }
        if (!value || typeof value !== 'object') continue;
        const item = value as Record<string, unknown>, types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        if (types.includes('JobPosting') && typeof item.datePosted === 'string') return item.datePosted;
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
      }
      return null;
    });
    if (published && Number.isFinite(Date.parse(published)) && Date.parse(published) <= Date.now()) {
      detail.listedAt = new Date(published).toISOString();
      detail.ageDays = Math.floor((Date.now() - Date.parse(published)) / 86400000);
    }
    if (!detail.description?.trim()) throw new Error('The original vacancy description could not be read.');
    return { ...detail, id: stub.id, platform: 'jora', source: stub.source, listingSourceUrl: source.url,
      url: destination, applicationUrl: detail.applicationUrl ?? destination,
      ageDays: detail.ageDays ?? job.ageDays, listedAt: detail.listedAt ?? job.listedAt };
  } finally { await guard.stop(); }
}

export async function applyToJoraJob(page: Page, job: JobListing, profile: CandidateProfile, deps: ApplyDeps): Promise<ApplyOutcome> {
  // The coordinator checks original posting identities after discovery and
  // keeps its existing per-vacancy duplicate lock and application allowance.
  const board = jobBoardForUrl(job.url);
  if((board || jobBoardForUrl(job.applicationUrl??job.url)) && applicationModelEnvironment().FREE_EMPLOYER_GUEST_ONLY==='true')
    return {status:'skipped',jobId:job.id,reason:'Free Jora discovery supports direct employer applications only. This listing leads to a job board.'};
  if (board === 'seek') return applyToJobWithAgent(page, job, profile, deps);
  if (board === 'indeed') return applyToIndeedJob(page, job, profile, deps);
  if (!config.allowExternalApply) return { status: 'off-platform', jobId: job.id, redirectedTo: job.applicationUrl ?? job.url };
  if (outsideScope('external')) return { status: 'skipped', jobId: job.id, reason: scopeSkipReason() };
  if (config.dryRun && process.env.REHEARSE !== 'true') return { status: 'skipped', jobId: job.id, reason: 'Dry run — forms are not opened.' };
  const before = new Set(page.context().pages());
  const guard = await guardExternalNavigations(page.context());
  try {
    await page.goto(job.applicationUrl ?? job.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const run = await runApplicationAgent({ page, job, profile, log: line => console.log(line) });
    return outcomeFromRun(run, job.id, page.url(), deps.onFriction);
  } finally {
    for (const tab of page.context().pages()) if (tab !== page && !before.has(tab)) await tab.close().catch(() => {});
    await guard.stop();
  }
}
