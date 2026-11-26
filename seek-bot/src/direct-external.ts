import { createHash } from 'node:crypto';
import type { Page } from 'patchright';
import { waitForChallengeToClear } from './browser.js';
import { jobBoardForUrl, isExternalApplicationUrl, nativeBoardPosting, type JobBoard } from './job-board-url.js';
import { pendingApplicationKeys, preparingApplications } from './application-review.js';
import { applicationKeys } from './application-identity.js';
import { reviewDuplicate } from './duplicate-review.js';
import { assertExternalJobUrl, guardExternalNavigations } from './external-url.js';
import { prepareMatchedJob } from './prepare-job.js';
import { runApplicationAgent } from './agent/loop.js';
import { waitForApplicationSurface } from './agent/observe.js';
import { outcomeFromRun } from './agent/outcome.js';
import { applicationFailureContext } from './application-diagnostics.js';
import { assessFit } from './llm.js';
import { refreshMatchedApplication } from './matched-application.js';
import { priorDirectApproval } from './direct-retry-approval.js';
import { config } from './config.js';
import { AppliedIndex, logOutcome, saveRunSummary, recordUnconfirmedApplication } from './store.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';

interface PageIdentity {
  title: string;
  company: string;
  location: string;
  description: string;
}

export async function identifyDirectJob(page: Page, board?: JobBoard): Promise<PageIdentity> {
  return page.evaluate(async (board) => {
    const values: unknown[] = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { values.push(JSON.parse(script.textContent ?? 'null')); } catch { /* malformed metadata is only a fallback */ }
    }
    const queue = [...values];
    let posting: Record<string, any> | null = null;
    while (queue.length) {
      const value = queue.shift();
      if (Array.isArray(value)) { queue.push(...value); continue; }
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, any>;
      const kinds = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
      if (kinds.some((kind) => String(kind).toLowerCase() === 'jobposting')) { posting = record; break; }
      if (Array.isArray(record['@graph'])) queue.push(...record['@graph']);
    }
    const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const places = Array.isArray(posting?.jobLocation) ? posting.jobLocation : [posting?.jobLocation];
    const locations = places.map(place => clean(place?.address?.addressLocality || place?.address?.addressRegion || '')).filter(Boolean);
    const visible = (element: Element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    // A comma-separated selector returns document order, so a shared portal
    // header can precede the actual vacancy even when main is listed first.
    const heading = ([...document.querySelectorAll('main h1, [role="main"] h1')].find(visible)
      ?? [...document.querySelectorAll('h1')].find(visible))?.textContent;
    const siteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
    const host = location.hostname.replace(/^www\./, '');
    const employer = board === 'seek' ? document.querySelector('[data-automation="advertiser-name"], [data-automation="job-detail-company-name"]')
      : board === 'indeed' ? document.querySelector('[data-testid="inlineHeader-companyName"], [data-company-name="true"]') : null;
    // Amazon publishes the employing entity beside the vacancy number rather
    // than in JobPosting JSON-LD. Its portal brand is not the employer name.
    const amazonId = host === 'amazon.jobs' ? location.pathname.match(/^\/[a-z]{2}(?:-[A-Z]{2})?\/jobs\/(\d+)(?:\/|$)/)?.[1] : undefined;
    const amazonMeta = amazonId ? [...document.querySelectorAll('#job-detail .details-line .meta')].find(visible) : undefined;
    const amazonIdentity = clean(amazonMeta?.textContent).match(/^Job ID:\s*(\d+)\s*\|\s*(.+)$/i);
    const amazonCompany = amazonIdentity?.[1] === amazonId ? amazonIdentity?.[2] : undefined;
    const amazonBody = amazonCompany ? document.querySelector('#job-detail-body .content') as HTMLElement | null : null;
    if (amazonCompany) locations.push(...[...document.querySelectorAll('#job-detail-body .association.location-icon .association-content li')]
      .filter(visible).map(node => clean(node.textContent)).filter(Boolean));
    // Google Careers keeps a visible, generic H1 outside the vacancy's main
    // panel. Confirm its metadata against the panel's actual role heading.
    const googleCareers = host === 'google.com' && /^\/about\/careers\/applications\/jobs\/results\/\d+-/.test(location.pathname);
    const googleTitle = googleCareers ? document.querySelector('meta[property="og:title"]')?.getAttribute('content') : null;
    const googleHeading = googleTitle ? [...document.querySelectorAll('main h2, [role="main"] h2')]
      .find(element => clean(element.textContent) === clean(googleTitle)
        && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) : undefined;
    const title = clean((board && heading) || posting?.title || googleHeading?.textContent || heading || (board ? '' : document.title || 'Direct employer application'));
    // Workday's JSON-LD can omit additional advertised locations. Its public
    // posting endpoint supplies them; bind the response to this exact vacancy.
    const tenant = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i)?.[1];
    const parts = location.pathname.split('/').filter(Boolean);
    const offset = /^[a-z]{2}-[a-z]{2}$/i.test(parts[0] ?? '') ? 1 : 0;
    const careerSite = parts[offset];
    const jobPath = parts.slice(offset + 1);
    const requisition = jobPath.at(-1)?.match(/_([a-z0-9-]+)$/i)?.[1];
    if (tenant && careerSite && /^[a-z0-9_-]+$/i.test(careerSite) && jobPath[0] === 'job' && requisition) {
      try {
        const endpoint = new URL(`/wday/cxs/${tenant}/${careerSite}/${jobPath.join('/')}`, location.origin);
        const response = await fetch(endpoint.href, { credentials: 'omit', signal: AbortSignal.timeout(5_000) });
        if (response.ok) {
          const info = (await response.json())?.jobPostingInfo;
          if (info?.jobReqId === requisition && clean(info.title) === title) {
            const extra: unknown[] = [info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : [])];
            locations.push(...extra.filter((value): value is string => typeof value === 'string').map(clean).filter(Boolean));
          }
        }
      } catch { /* Keep the observed page facts when the public endpoint is unavailable. */ }
    }
    return {
      title,
      company: clean(employer?.textContent || posting?.hiringOrganization?.name || amazonCompany || (board ? '' : googleHeading ? 'Google' : siteName || host)),
      location: [...new Set(locations)].join('; ').slice(0, 2_000),
      description: (() => {
        if (posting?.description) {
          const text = document.createElement('div'); text.innerHTML = String(posting.description);
          return text.textContent?.trim().slice(0, 60000) ?? '';
        }
        return (amazonBody || document.querySelector('main, [role="main"]') as HTMLElement | null)?.innerText?.trim().slice(0, 60000) ?? '';
      })(),
    };
  }, board);
}

/** A pasted posting supplies only its identity; live board evidence supplies all matching facts. */
export async function readNativeBoardTarget(page: Page, target: NonNullable<ReturnType<typeof nativeBoardPosting>>): Promise<JobListing> {
  await page.goto(target.url, { waitUntil: 'domcontentloaded' });
  await waitForChallengeToClear(page);
  await page.locator('h1, script[type="application/ld+json"]').first().waitFor({state:'attached', timeout:15_000}).catch(() => {});
  const current = nativeBoardPosting(page.url());
  if (current?.id !== target.id || current.platform !== target.platform) throw new Error('The job board did not open the requested vacancy.');
  const facts = await identifyDirectJob(page, target.platform);
  if (!facts.title || !facts.company) throw new Error('The job board did not show a job title and employer for the requested vacancy.');
  return { ...facts, ...target, source: 'search' };
}

/** Recover the live advert before matching an unapproved repair from a source without a search adapter. */
export async function readSavedEmployerListing(page: Page, job: JobListing): Promise<JobListing> {
  const url = await assertExternalJobUrl(job.url, undefined, false);
  const guard = await guardExternalNavigations(page.context());
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator('h1, main, [role="main"], script[type="application/ld+json"]').first().waitFor({state:'attached', timeout:15_000}).catch(() => {});
    const facts = await identifyDirectJob(page, jobBoardForUrl(page.url()) ?? undefined);
    const company = facts.company === new URL(page.url()).hostname.replace(/^www\./, '') ? job.company : facts.company || job.company;
    return { ...job, ...facts, title: facts.title || job.title, company, location: facts.location || job.location,
      applicationUrl: page.url(), applicationMode: 'external' };
  } finally {
    await guard.stop();
  }
}

/** Applies to exactly the operator-supplied page, using the same current-preference review as discovered vacancies. */
export async function runDirectExternalApplication(
  page: Page,
  url: string,
  profile: CandidateProfile,
  navigationBlocked: () => string | null,
  test?: { runAgent: typeof runApplicationAgent; match?: typeof assessFit; refreshPrior?: (previous: JobListing) => Promise<JobListing> },
): Promise<ReturnType<typeof nativeBoardPosting> | void> {
  if (test && (!config.dryRun || !new URL(url).hostname.endsWith('.invalid'))) {
    throw new Error('Direct application dependency overrides require an isolated dry-run fixture.');
  }
  const stableUrl = new URL(url);
  stableUrl.hash = '';
  const id = `external-${createHash('sha256').update(stableUrl.href).digest('hex').slice(0, 24)}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (error) {
    const blocked = navigationBlocked();
    throw new Error(blocked ? `Direct website navigation was blocked: ${blocked}` : `Could not open the direct job URL: ${(error as Error).message}`);
  }
  await page.waitForFunction(() => Boolean(document.body?.innerText.trim()), undefined, { timeout: 15_000 }).catch(() => {});
  const board = jobBoardForUrl(page.url());
  if(!board && !preparingApplications())await waitForApplicationSurface(page, 5_000).catch(() => false);
  const identity = await identifyDirectJob(page, board ?? undefined);
  let job: JobListing = {
    id,
    title: identity.title || 'Direct employer application',
    company: identity.company || new URL(page.url()).hostname,
    location: identity.location,
    url,
    applicationUrl: page.url(),
    applicationMode: 'external',
    platform: 'external',
    source: 'search',
    description: identity.description,
  };
  const index = new AppliedIndex();
  const pending = pendingApplicationKeys();
  const original = { ...job, applicationUrl: job.url };
  const duplicate = [job, original].map(alias => reviewDuplicate(alias, index.all)).find(review => review.decision === 'duplicate');
  if ([job, original].some(alias => applicationKeys(alias).some(key => pending.has(key))) || duplicate) {
    const reason = duplicate?.reason ?? 'This application is already awaiting a decision.';
    saveRunSummary(0);
    logOutcome({ status: duplicate ? 'already-applied' : 'skipped', jobId: job.id, title: job.title, company: job.company, url: job.url, reason });
    console.log(reason);
    console.log('\n=== Run complete: 0 new application(s) ===');
    return;
  }
  if (board) {
    const posting = nativeBoardPosting(page.url());
    if (!posting) throw new Error('The employer redirected to a job board without identifying a specific vacancy.');
    return posting;
  }
  if ((!config.allowExternalApply || config.limits.maxApplicationsPerRun < 1
    || index.appliedToday() >= config.limits.maxApplicationsPerDay
    || config.limits.externalAttemptsToday >= config.limits.maxExternalPerDay)) {
    saveRunSummary(0);
    logOutcome({ status: 'skipped', jobId: job.id, title: job.title, company: job.company,
      reason: 'No employer-site application allowance is available for this run.' });
    console.log('No employer-site application allowance is available for this run.');
    console.log('\n=== Run complete: 0 new application(s) ===');
    return;
  }

  // Recover a still-current matcher approval from this owner's failed unsent
  // attempt before treating the same URL as newly discovered work.
  const prior = await priorDirectApproval(job, profile, test?.refreshPrior);
  if (prior) {
    job = prior;
    console.log(`Reusing the saved ${prior.fitReview!.score}/100 matching approval for this unchanged vacancy and candidate context.`);
  }
  // Bare URLs and changed facts still need the ordinary matching review.
  const reviewed = await refreshMatchedApplication(job, job, profile, test?.match ?? assessFit);
  if ('outcome' in reviewed) {
    saveRunSummary(0);
    logOutcome({ ...reviewed.outcome, title: job.title, company: job.company, url: job.url });
    console.log('Direct website job did not pass current-preference review.');
    console.log('\n=== Run complete: 0 new application(s) ===');
    return;
  }
  job = reviewed.job;
  saveRunSummary(1);
  console.log(`Direct website job: ${job.title} @ ${job.company}`);
  let outcome: ApplyOutcome | undefined;
  try {
    if(preparingApplications())outcome=await prepareMatchedJob(job,profile,{page});
    else{
    const apply = () => (test?.runAgent ?? runApplicationAgent)({ page, job, profile, handoffNativePosting: true, log: (line: string) => console.log(line) });
    const run = await apply();
    console.log(`  agent: ${run.steps} steps · ${run.usage}`);
    if (!run.submitPressed && run.outcome.status === 'off-platform') {
      const posting = nativeBoardPosting(run.outcome.redirectedTo);
      if (posting) return posting;
    }
    outcome = outcomeFromRun(run, job.id, page.url());
    }
  } catch (error) {
    outcome = { status: 'error', jobId: job.id, error: (error as Error).message,
      submitPressed: applicationFailureContext(error)?.submitPressed === true };
  }
  recordUnconfirmedApplication(index, job, outcome);
  logOutcome({ ...outcome, title: job.title, company: job.company, url: job.url });
  for (const action of outcome.actions ?? []) console.log(`  ℹ ${action.detail}`);

  if (outcome.status === 'applied') {
    index.add({
      jobId: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
      appliedAt: outcome.at,
      ...(outcome.applicationUrl ? { applicationUrl: outcome.applicationUrl } : {}),
      score: job.fitReview!.score,
      platform: job.platform ?? 'external',
      coverLetter: outcome.coverLetter,
      answers: outcome.answers,
      ...(outcome.resume ? { resume: outcome.resume } : {}),
      scoreReasons: job.fitReview!.evidence,
      external: isExternalApplicationUrl(outcome.applicationUrl ?? job.applicationUrl ?? job.url),
      ...(outcome.site ? { site: outcome.site } : {}),
      ...(outcome.actions?.length ? { actions: outcome.actions } : {}),
      submittedByMyasis: true,
    });
    console.log('  ✅ submitted [external] (1/1)');
  } else if (outcome.status === 'prepared') {
    console.log(`  Ready for confirmation: ${job.title} @ ${job.company}`);
  } else if (outcome.status === 'needs-human') {
    console.log(`  ⏸ needs your answer: ${outcome.reason}`);
  } else if (outcome.status === 'already-applied') {
    console.log(`  ↩ already applied: ${outcome.reason}`);
  } else if (outcome.status === 'skipped') {
    console.log(outcome.submitPressed ? `  Submission not confirmed: ${outcome.reason}` : `  – skipped: ${outcome.reason}`);
  } else if (outcome.status === 'error') {
    console.log(outcome.submitPressed ? `  Submission not confirmed: ${outcome.error}` : `  ✕ error: ${outcome.error}`);
  } else {
    console.log(`  – ${outcome.status}`);
  }
  console.log(preparingApplications()?`\n=== Semi auto complete: ${outcome.status==='prepared'?1:0} application(s) ready for confirmation ===`:`\n=== Run complete: ${outcome.status === 'applied' ? 1 : 0} new application(s) ===`);
}
