import { createHash } from 'node:crypto';
import type { Page } from 'patchright';
import { runApplicationAgent } from './agent/loop.js';
import { waitForApplicationSurface } from './agent/observe.js';
import { outcomeFromRun } from './agent/outcome.js';
import { applicationFailureContext } from './application-diagnostics.js';
import { config } from './config.js';
import { AppliedIndex, logOutcome, saveRunSummary } from './store.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';

interface PageIdentity {
  title: string;
  company: string;
  location: string;
}

async function identify(page: Page): Promise<PageIdentity> {
  return page.evaluate(() => {
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
    const address = Array.isArray(posting?.jobLocation) ? posting?.jobLocation[0]?.address : posting?.jobLocation?.address;
    const heading = [...document.querySelectorAll('main h1, [role="main"] h1, h1')]
      .find(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))?.textContent;
    const siteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
    const host = location.hostname.replace(/^www\./, '');
    return {
      title: clean(posting?.title || heading || document.title || 'Direct employer application'),
      company: clean(posting?.hiringOrganization?.name || siteName || host),
      location: clean(address?.addressLocality || address?.addressRegion || ''),
    };
  });
}

/** Applies to exactly the operator-supplied page, with no board discovery or fit gate. */
export async function runDirectExternalApplication(
  page: Page,
  url: string,
  profile: CandidateProfile,
  navigationBlocked: () => string | null,
  test?: { runAgent: typeof runApplicationAgent },
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
  const identity = await identify(page);
  const job: JobListing = {
    id,
    title: identity.title || 'Direct employer application',
    company: identity.company || new URL(page.url()).hostname,
    location: identity.location,
    url,
    applicationUrl: page.url(),
    applicationMode: 'external',
    platform: 'external',
    source: 'chosen',
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

  saveRunSummary(1);
  console.log(`Direct website job: ${job.title} @ ${job.company}`);
  let outcome: ApplyOutcome | undefined;
  try {
    const apply = () => (test?.runAgent ?? runApplicationAgent)({ page, job, profile, log: (line: string) => console.log(line) });
    const run = await apply();
    console.log(`  agent: ${run.steps} steps · ${run.usage}`);
    outcome = outcomeFromRun(run, job.id, page.url());
  } catch (error) {
    outcome = { status: 'error', jobId: job.id, error: (error as Error).message,
      submitPressed: applicationFailureContext(error)?.submitPressed === true };
  }
  logOutcome({ ...outcome, title: job.title, company: job.company });
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
      score: 100,
      platform: 'external',
      coverLetter: outcome.coverLetter,
      answers: outcome.answers,
      scoreReasons: ['Administrator supplied this exact employer job URL.'],
      external: true,
      ...(outcome.site ? { site: outcome.site } : {}),
      ...(outcome.actions?.length ? { actions: outcome.actions } : {}),
      submittedByMyasis: true,
    });
    console.log('  ✅ submitted [external] (1/1)');
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
  console.log(`\n=== Run complete: ${outcome.status === 'applied' ? 1 : 0} new application(s) ===`);
}
