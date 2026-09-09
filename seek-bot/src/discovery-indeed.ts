import type { Page } from 'patchright';
import { config } from './config.js';
import { jitter } from './browser.js';
import type { JobListing } from './types.js';

/**
 * How Indeed actually works (verified live against au.indeed.com, signed in,
 * Sep 2026):
 *
 * Both the homepage's personalised "Jobs for you" feed and the `/jobs` search
 * results page hydrate `window.mosaic.providerData` client-side. The relevant
 * provider is keyed `mosaic-provider-jobcards-1` on the homepage and
 * `mosaic-provider-jobcards` (no suffix) on `/jobs` search results; both
 * expose `.metaData.mosaicProviderJobCardsModel.results` — an array of full,
 * structured job objects (jobkey, title, company, formattedLocation,
 * extractedSalary {min,max,type}, salarySnippet.text, pubDate epoch-ms,
 * jobTypes[], remoteLocation bool, indeedApplyable bool, thirdPartyApplyUrl,
 * sponsored, expired, screenerQuestionsURL, ...). Same "read the hydrated
 * client state, no GraphQL replay needed" approach as SEEK's Apollo cache,
 * just a different global and a slightly different key per page type.
 *
 * DOM fallback: job title anchors carry `data-jk="<jobkey>"` with class
 * `jcs-JobTitle`; cards carry `data-testid="company-name"` / `"text-location"`.
 *
 * Detail fetching is the one place Indeed genuinely differs from SEEK, and it
 * is load-bearing: a top-level navigation straight to `/viewjob?jk=<id>` (no
 * search-session context — e.g. `page.goto()` on a bare job URL) trips a
 * Cloudflare Turnstile "Additional Verification Required" interstitial almost
 * immediately — reproduced live. But the exact same detail payload is also
 * available from an in-page `fetch()` to
 * `/viewjob?jk=<id>&viewtype=embedded&spa=1&tk=<current-page-session-token>`
 * (the request the page's own JS makes when you click a job card) — that
 * succeeds for ANY job id, from ANY already-loaded au.indeed.com page,
 * without ever hitting the Cloudflare check, because it carries the page's
 * own cookies/session tokens exactly like the real SPA click does. So detail
 * fetching here always goes through that in-page fetch, never `page.goto()`
 * on a job URL.
 */

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

/** Indeed's description comes back as sanitised HTML; strip it to plain text. */
function htmlToText(html?: string): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|br|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => HTML_ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ageDaysFromEpochMs(ms?: number): number | undefined {
  if (!ms || !Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/**
 * Walks an arbitrary object graph looking for the array of job records.
 * Shape-tolerant, mirroring discovery.ts's `deepFindJobArray` — Indeed's
 * provider key naming already differs between homepage and search (`-1`
 * suffix vs none), so a fixed path is not safe to assume stays put.
 */
function deepFindJobArray(root: any, maxDepth = 6): any[] | null {
  const seen = new Set<any>();
  const looksLikeJob = (o: any) => o && typeof o === 'object' && typeof o.jobkey === 'string' && typeof o.title === 'string';

  const walk = (node: any, depth: number): any[] | null => {
    if (!node || typeof node !== 'object' || depth > maxDepth) return null;
    if (seen.has(node)) return null;
    seen.add(node);

    if (Array.isArray(node)) {
      if (node.length && node.filter(looksLikeJob).length >= Math.min(3, node.length)) return node;
      for (const child of node) {
        const hit = walk(child, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const key of Object.keys(node)) {
      const hit = walk(node[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  return walk(root, 0);
}

function annualSalaryMin(extracted?: { min?: number; max?: number; type?: string }): number | undefined {
  if (!extracted || typeof extracted.min !== 'number') return undefined;
  return extracted.type === 'YEARLY' ? extracted.min : undefined;
}

function normalise(raw: any): JobListing | null {
  const id = String(raw?.jobkey ?? '').trim();
  const title = raw?.title ?? raw?.displayTitle;
  if (!id || !title) return null;

  const hasApplyMode = typeof raw?.indeedApplyable === 'boolean';
  return {
    id,
    title: String(raw?.displayTitle ?? title),
    company: String(raw?.company ?? raw?.truncatedCompany ?? 'Unknown'),
    location: String(raw?.formattedLocation ?? 'Unknown'),
    workArrangement: raw?.remoteLocation ? 'Remote' : undefined,
    salary: typeof raw?.salarySnippet?.text === 'string' ? raw.salarySnippet.text : undefined,
    inferredMinSalary: annualSalaryMin(raw?.extractedSalary),
    listedAt: raw?.formattedRelativeTime,
    ageDays: ageDaysFromEpochMs(raw?.pubDate),
    url: `${config.indeedBase}/viewjob?jk=${id}`,
    teaser: raw?.snippet || undefined,
    platform: 'indeed',
    indeedApplyable: hasApplyMode ? raw.indeedApplyable : undefined,
    applicationMode: hasApplyMode ? (raw.indeedApplyable ? 'hosted' : 'external') : 'unknown',
    applicationUrl: typeof raw?.thirdPartyApplyUrl === 'string' ? raw.thirdPartyApplyUrl : undefined,
  };
}

/** Reads the signed-in candidate's personalised "Jobs for you" homepage feed. */
export async function recommended(page: Page): Promise<JobListing[]> {
  // Same reasoning as SEEK's personalised feed — see discovery.ts. It carries
  // no distance parameter, so it cannot honour a configured search radius.
  if (config.search.location && config.search.radiusKm > 0) {
    console.log(
      `  Indeed "Jobs for you" skipped — the personalised feed cannot be limited to ${config.search.radiusKm} km`,
    );
    return [];
  }

  await page.goto(`${config.indeedBase}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-jk]', { timeout: 15_000 }).catch(() => {});
  await jitter(600, 1400);

  const rows: any[] = await page.evaluate(() => {
    const providerData = (window as any).mosaic?.providerData;
    if (!providerData) return [];
    const direct = providerData['mosaic-provider-jobcards-1']?.metaData?.mosaicProviderJobCardsModel?.results;
    if (Array.isArray(direct)) return direct;
    for (const key of Object.keys(providerData)) {
      if (!/^mosaic-provider-jobcards/i.test(key)) continue;
      const results = providerData[key]?.metaData?.mosaicProviderJobCardsModel?.results;
      if (Array.isArray(results)) return results;
    }
    return [];
  });

  let jobs = rows.map(normalise).filter((j): j is JobListing => j !== null);
  if (!jobs.length) {
    // Deep-scan fallback in case the provider key ever moves entirely.
    const raw = await page.evaluate(() => JSON.stringify((window as any).mosaic?.providerData ?? {})).catch(() => '');
    const arr = raw ? deepFindJobArray(JSON.parse(raw)) ?? [] : [];
    jobs = arr.map(normalise).filter((j): j is JobListing => j !== null);
  }

  return jobs.map((job) => ({ ...job, source: 'recommended' as const }));
}

/** Primary path: pull the hydrated result set out of `window.mosaic`. */
export async function searchViaMosaic(page: Page, keywords: string, pageNum = 1): Promise<JobListing[]> {
  const start = (pageNum - 1) * 10;
  const url =
    `${config.indeedBase}/jobs?q=${encodeURIComponent(keywords)}&l=${encodeURIComponent('Australia')}&sort=date` +
    (start > 0 ? `&start=${start}` : '');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-jk]', { timeout: 15_000 }).catch(() => {});
  await jitter(600, 1400);

  const rows: any[] = await page.evaluate(() => {
    const providerData = (window as any).mosaic?.providerData;
    if (!providerData) return [];
    const direct = providerData['mosaic-provider-jobcards']?.metaData?.mosaicProviderJobCardsModel?.results;
    if (Array.isArray(direct)) return direct;
    for (const key of Object.keys(providerData)) {
      if (!/^mosaic-provider-jobcards/i.test(key)) continue;
      const results = providerData[key]?.metaData?.mosaicProviderJobCardsModel?.results;
      if (Array.isArray(results)) return results;
    }
    return [];
  });

  return rows.map(normalise).filter((j): j is JobListing => j !== null);
}

/** Fallback: read the rendered cards via Indeed's own `data-jk`/`data-testid` hooks. */
export async function searchViaDom(page: Page, keywords: string, pageNum = 1): Promise<JobListing[]> {
  const start = (pageNum - 1) * 10;
  const url =
    `${config.indeedBase}/jobs?q=${encodeURIComponent(keywords)}&l=${encodeURIComponent('Australia')}&sort=date` +
    (start > 0 ? `&start=${start}` : '');
  if (!page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-jk]', { timeout: 15_000 }).catch(() => {});
  }

  const rows = await page.evaluate(() => {
    const out: any[] = [];
    document.querySelectorAll('a.jcs-JobTitle[data-jk]').forEach((anchor) => {
      const id = anchor.getAttribute('data-jk');
      if (!id) return;
      const card = anchor.closest('[data-testid="slider_item"], .job_seen_beacon, li, div');
      const txt = (sel: string) => card?.querySelector(`[data-testid="${sel}"]`)?.textContent?.trim() || undefined;
      out.push({
        id,
        title: anchor.textContent?.trim() ?? '',
        company: txt('company-name'),
        location: txt('text-location'),
        salary: card?.querySelector('[data-testid^="attribute_snippet_testid salary"]')?.textContent?.trim(),
      });
    });
    return out;
  });

  return rows
    .filter((r) => r.id && r.title)
    .map((r) => ({
      id: String(r.id),
      title: r.title,
      company: r.company ?? 'Unknown',
      location: r.location ?? 'Unknown',
      salary: r.salary || undefined,
      url: `${config.indeedBase}/viewjob?jk=${r.id}`,
      platform: 'indeed' as const,
    }));
}

export async function search(page: Page, keywords: string, pageNum = 1): Promise<JobListing[]> {
  const viaMosaic = await searchViaMosaic(page, keywords, pageNum).catch(() => []);
  if (viaMosaic.length) return viaMosaic.map((job) => ({ ...job, source: 'search' as const }));
  console.warn(`  [discovery-indeed] mosaic data empty for "${keywords}" p${pageNum} — using DOM`);
  return (await searchViaDom(page, keywords, pageNum)).map((job) => ({ ...job, source: 'search' as const }));
}

/**
 * Fetches the full detail payload for one job via the same in-page request
 * Indeed's own SPA makes when you click a card — never a top-level
 * `page.goto()` to a job URL (see the module comment for why).
 */
export async function fetchJobDetail(page: Page, job: JobListing): Promise<JobListing> {
  if (!/indeed\.com/i.test(page.url())) {
    await page.goto(`${config.indeedBase}/`, { waitUntil: 'domcontentloaded' });
  }
  // `mosaic.initialData.logTk` is set by an inline script shortly after
  // domcontentloaded — wait for it so a cold navigation doesn't fetch with an
  // empty session token (see the same race in browser.ts's sign-in check).
  await page
    .waitForFunction(() => (window as any).mosaic?.initialData?.logTk !== undefined, { timeout: 8_000 })
    .catch(() => {});
  await jitter(500, 1200);

  const result = await page
    .evaluate(async (jobId: string) => {
      const tk = (window as any).mosaic?.initialData?.logTk ?? '';
      const url = `/viewjob?jk=${encodeURIComponent(jobId)}&from=vjs&tk=${encodeURIComponent(
        tk,
      )}&viewtype=embedded&spa=1&hidecmpheader=0`;
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return { ok: false as const, reason: `HTTP ${res.status}` };
        const json = await res.json();
        if (json?.status !== 'success' || !json?.body) return { ok: false as const, reason: 'unexpected payload' };
        return { ok: true as const, body: json.body };
      } catch (err) {
        return { ok: false as const, reason: String((err as Error)?.message ?? err) };
      }
    }, job.id)
    .catch((err) => ({ ok: false as const, reason: String((err as Error)?.message ?? err) }));

  if (!result.ok) {
    console.warn(`  [discovery-indeed] detail fetch failed for ${job.id}: ${result.reason}`);
    return { ...job, description: job.teaser ?? '' };
  }

  const body: any = result.body;
  const jobInfoModel = body?.jobInfoWrapperModel?.jobInfoModel ?? {};
  const header = jobInfoModel?.jobInfoHeaderModel ?? {};
  const description = htmlToText(jobInfoModel?.sanitizedJobDescription) || job.teaser || '';

  /**
   * `appliedStateBannerModel` is Indeed's own "you applied" marker — the only
   * thing that knows about applications made outside this tool, exactly like
   * SEEK's "You applied on …" callout. Its populated shape was not observed
   * live (every job checked during verification was un-applied), so this
   * reads it shape-tolerantly: any non-null value counts as applied, and any
   * string field on it is used as the note.
   */
  const appliedBanner = jobInfoModel?.appliedStateBannerModel;
  const appliedNote =
    appliedBanner && typeof appliedBanner === 'object'
      ? Object.values(appliedBanner).find((v) => typeof v === 'string' && v.trim())
      : undefined;

  // `jobMetadataHeaderModel.jobType` is "Full-time"/"Contract"/etc — a job
  // type, not a work *arrangement* (remote/hybrid/on-site). Keep those
  // separate: workArrangement only ever reflects Indeed's remote signal here,
  // and classifyArrangement()/isRemoteOrHybrid() in scoring.ts fall back to
  // scanning the now-populated full description for "hybrid"/"remote" wording.
  return {
    ...job,
    description,
    location: header?.formattedLocation || job.location,
    workArrangement: header?.remoteLocation ? 'Remote' : job.workArrangement,
    alreadyApplied: Boolean(appliedBanner),
    appliedNote: typeof appliedNote === 'string' ? appliedNote : undefined,
  };
}
