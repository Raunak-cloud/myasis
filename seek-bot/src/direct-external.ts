import { createHash } from 'node:crypto';
import type { Page } from 'patchright';
import { preparingApplications } from './application-review.js';
import { prepareMatchedJob } from './prepare-job.js';
import { runApplicationAgent } from './agent/loop.js';
import { waitForApplicationSurface } from './agent/observe.js';
import { outcomeFromRun } from './agent/outcome.js';
import { applicationFailureContext } from './application-diagnostics.js';
import { assessFit } from './llm.js';
import { refreshMatchedApplication } from './matched-application.js';
import { config } from './config.js';
import { AppliedIndex, logOutcome, saveRunSummary, recordUnconfirmedApplication } from './store.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';

interface PageIdentity {
  title: string;
  company: string;
  location: string;
  description: string;
}

export async function identifyDirectJob(page: Page): Promise<PageIdentity> {
  return page.evaluate(async () => {
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
    // Google Careers keeps a visible, generic H1 outside the vacancy's main
    // panel. Confirm its metadata against the panel's actual role heading.
    const googleCareers = host === 'google.com' && /^\/about\/careers\/applications\/jobs\/results\/\d+-/.test(location.pathname);
    const googleTitle = googleCareers ? document.querySelector('meta[property="og:title"]')?.getAttribute('content') : null;
    const googleHeading = googleTitle ? [...document.querySelectorAll('main h2, [role="main"] h2')]
      .find(element => clean(element.textContent) === clean(googleTitle)
        && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) : undefined;
    const title = clean(posting?.title || googleHeading?.textContent || heading || document.title || 'Direct employer application');
    // Workday's JSON-LD can omit additional advertised locations. Its public
    // posting endpoint supplies them; bind the response to this exact vacancy.
    const tenant = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i)?.[1];
    const parts = location.pathname.split('/').filter(Boolean);
    const offset = /^[a-z]{2}-[a-z]{2}$/i.test(parts[0] ?? '') ? 1 : 0;
    const board = parts[offset];
    const jobPath = parts.slice(offset + 1);
    const requisition = jobPath.at(-1)?.match(/_([a-z0-9-]+)$/i)?.[1];
    if (tenant && board && /^[a-z0-9_-]+$/i.test(board) && jobPath[0] === 'job' && requisition) {
      try {
        const endpoint = new URL(`/wday/cxs/${tenant}/${board}/${jobPath.join('/')}`, location.origin);
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
      company: clean(posting?.hiringOrganization?.name || (googleHeading ? 'Google' : siteName || host)),
      location: [...new Set(locations)].join('; ').slice(0, 2_000),
      description: (() => {
        if (posting?.description) {
          const text = document.createElement('div'); text.innerHTML = String(posting.description);
          return text.textContent?.trim().slice(0, 60000) ?? '';
        }
        return (document.querySelector('main, [role="main"]') as HTMLElement | null)?.innerText?.trim().slice(0, 60000) ?? '';
      })(),
    };
  });
}

/** Applies to exactly the operator-supplied page, using the same current-preference review as discovered vacancies. */
export async function runDirectExternalApplication(
  page: Page,
  url: string,
  profile: CandidateProfile,
  navigationBlocked: () => string | null,
  test?: { runAgent: typeof runApplicationAgent; match?: typeof assessFit },
): Promise<void> {
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
  await waitForApplicationSurface(page, 5_000).catch(() => false);
  const identity = await identifyDirectJob(page);
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

  // A URL is discovery input, not candidate approval of any occupation.
  // Review before an agent can fill a form or upload candidate data.
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
    if(preparingApplications())outcome=await prepareMatchedJob(page,job,profile);
    else{
    const apply = () => (test?.runAgent ?? runApplicationAgent)({ page, job, profile, log: (line: string) => console.log(line) });
    const run = await apply();
    console.log(`  agent: ${run.steps} steps · ${run.usage}`);
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
      platform: 'external',
      coverLetter: outcome.coverLetter,
      answers: outcome.answers,
      ...(outcome.resume ? { resume: outcome.resume } : {}),
      scoreReasons: job.fitReview!.evidence,
      external: true,
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
