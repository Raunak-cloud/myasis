import type { Page } from 'playwright';
import { config } from './config.js';
import { jitter } from './browser.js';
import type { JobListing } from './types.js';

/**
 * How SEEK actually works (verified against the live site, Aug 2026):
 *
 * There is NO client-side JSON search endpoint to replay. Results are
 * server-rendered; the only runtime GraphQL calls on a results page are a
 * salary nudge and a footer banner. What the page *does* expose is the Apollo
 * client itself (`window.__APOLLO_CLIENT__`), whose normalised cache holds the
 * hydrated `jobSearchV7` result set as structured objects.
 *
 * So: read the Apollo cache (structured, no selectors), and keep a
 * `data-automation`-based DOM reader as fallback. Those attributes are SEEK's
 * own automation hooks and are far stabler than CSS classes.
 */

/** "54m ago•Viewed", "3d ago", "Posted 2 days ago" → days */
export function parseAgeDays(text?: string): number | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  const m = t.match(/(\d+)\s*(m|h|d|w|min|hour|day|week)/);
  if (!m) return /just now|today/.test(t) ? 0 : undefined;
  const n = Number(m[1]);
  switch (m[2][0]) {
    case 'm':
      return 0;
    case 'h':
      return 0;
    case 'd':
      return n;
    case 'w':
      return n * 7;
    default:
      return undefined;
  }
}

function daysSinceIso(iso?: string): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * Walks an arbitrary object graph looking for the array of job records.
 * Deliberately shape-tolerant: SEEK renames these fields between releases, so
 * we identify jobs by their duck type (id + title) rather than a fixed path.
 */
function deepFindJobArray(root: any, maxDepth = 8): any[] | null {
  const seen = new Set<any>();
  const looksLikeJob = (o: any) =>
    o &&
    typeof o === 'object' &&
    (o.id !== undefined || o.jobId !== undefined) &&
    typeof (o.title ?? o.jobTitle) === 'string';

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

function normalise(raw: any): JobListing | null {
  const id = String(raw?.id ?? raw?.jobId ?? '').trim();
  const title = raw?.title ?? raw?.jobTitle;
  if (!id || !title) return null;

  const company =
    raw?.advertiser?.name ??
    raw?.organisation?.name ??
    raw?.companyName ??
    raw?.advertiser?.description ??
    'Unknown';

  /**
   * SEEK nests location several ways depending on the payload version, and an
   * unrecognised shape used to fall through to the raw object — stringifying
   * as "[object Object]" and silently breaking the on-site city filter.
   * Pull the first string-valued label found instead.
   */
  const readLocation = (v: any, depth = 0): string => {
    if (v == null || depth > 3) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => readLocation(x, depth + 1)).filter(Boolean).join(', ');
    if (typeof v !== 'object') return String(v);
    for (const key of ['label', 'name', 'text', 'description', 'countryCode']) {
      const got = readLocation(v[key], depth + 1);
      if (got) return got;
    }
    return '';
  };
  const location = readLocation(raw?.locations ?? raw?.location) || 'Unknown';

  const arrangements = raw?.workArrangements?.data ?? raw?.workArrangements ?? [];
  const workArrangement = Array.isArray(arrangements)
    ? arrangements.map((a: any) => a?.label?.text ?? a?.label ?? a?.text ?? a).filter(Boolean).join('/')
    : undefined;

  // `listedAt` is an object ({dateTimeUtc,label}) on the search payload but a
  // plain string elsewhere — accept either.
  const listedRaw = raw?.listedAt ?? raw?.listingDate ?? raw?.datePosted;
  const listedIso =
    typeof listedRaw === 'string'
      ? listedRaw
      : (listedRaw?.dateTimeUtc ?? listedRaw?.dateTime ?? listedRaw?.value);
  const listedLabel = typeof listedRaw === 'object' ? listedRaw?.label : undefined;

  /**
   * SEEK ships a structured range in `cjs.salary` (integer cents) even when the
   * advertiser sets `hideSalary`. We use it for the salary *filter* only, and
   * never present it as a disclosed figure — `salary` stays undefined so
   * downstream text and application answers keep saying "not disclosed".
   */
  const cjsSalary = raw?.cjs?.salary;
  const hidden = cjsSalary?.hideSalary === true;
  const displayValue = cjsSalary?.displayValue ?? raw?.salaryLabel ?? raw?.salary?.label;
  const minorUnits = typeof cjsSalary?.minimum === 'number' ? cjsSalary.minimum : undefined;
  const inferredMin =
    minorUnits !== undefined && /annual/i.test(cjsSalary?.period ?? '') ? minorUnits / 100 : undefined;

  return {
    id,
    title: String(title),
    company: String(company),
    location: String(location || 'Unknown'),
    workArrangement: workArrangement || undefined,
    salary: !hidden && typeof displayValue === 'string' ? displayValue : undefined,
    inferredMinSalary: inferredMin,
    listedAt: listedIso ?? listedLabel,
    ageDays: daysSinceIso(listedIso) ?? parseAgeDays(listedLabel),
    url: `${config.seekBase}/job/${id}`,
    teaser: raw?.abstract ?? raw?.teaser ?? raw?.shortDescription ?? undefined,
    platform: 'seek',
  };
}

/**
 * Reads the signed-in candidate's personalised SEEK Recommended feed.
 * The homepage hydrates it as `careerFeed` in Apollo, with each edge wrapping
 * a normal Job entity plus recommendation metadata.
 */
export async function recommended(page: Page): Promise<JobListing[]> {
  /**
   * The personalised feed cannot be limited by distance.
   *
   * It is whatever SEEK chose to show this account — Sydney-wide — with no
   * `where`/`distance` parameter to constrain, and `main.ts` evaluates it
   * *first*, as priority. So with a radius set it dominated the run and fed
   * in jobs 45 km from a 10 km search, which were then applied to. An
   * explicit geographic limit the candidate set has to win over the
   * convenience of the feed, and the job payload carries no coordinates to
   * filter on locally, so the feed is skipped outright while a radius is in
   * force. Keyword search still runs, and it *is* distance-filtered.
   */
  if (config.search.location && config.search.radiusKm > 0) {
    console.log(
      `  SEEK Recommended skipped — the personalised feed cannot be limited to ${config.search.radiusKm} km`,
    );
    return [];
  }

  await page.goto(config.seekBase, { waitUntil: 'domcontentloaded' });
  await page
    .waitForSelector('[data-automation^="recommendedJobLink_"]', { timeout: 15_000 })
    .catch(() => {});
  await jitter(600, 1400);

  const rows: any[] = await page.evaluate(() => {
    const client = (window as any).__APOLLO_CLIENT__;
    if (!client?.cache?.extract) return [];
    const store = client.cache.extract();
    const root = store.ROOT_QUERY ?? {};
    const key = Object.keys(root).find((candidate) => /^careerFeed\(/i.test(candidate));
    if (!key) return [];

    const deref = (value: any, depth = 0): any => {
      if (!value || typeof value !== 'object' || depth > 6) return value;
      if (Array.isArray(value)) return value.map((item) => deref(item, depth + 1));
      if (typeof value.__ref === 'string') return deref(store[value.__ref], depth + 1);
      const out: any = {};
      for (const childKey of Object.keys(value)) out[childKey] = deref(value[childKey], depth + 1);
      return out;
    };
    const field = (object: any, name: string): any => {
      if (!object || typeof object !== 'object') return undefined;
      if (object[name] !== undefined) return object[name];
      const parameterised = Object.keys(object).find((candidate) => candidate.startsWith(`${name}(`));
      return parameterised ? object[parameterised] : undefined;
    };

    const feed = deref(root[key]);
    return (feed?.edges ?? []).flatMap((edge: any) => {
      const node = edge?.node;
      const job = node?.job;
      if (!job?.id || !job?.title) return [];
      const arrangementsKey = Object.keys(node).find((candidate) => candidate.startsWith('workArrangements'));
      const arrangement = arrangementsKey ? node[arrangementsKey] : undefined;
      return [{
        id: String(job.id),
        title: String(job.title),
        companyName: field(job.advertiser, 'name') ?? 'Unknown',
        location: field(job.location, 'label') ?? 'Unknown',
        workArrangements: arrangement?.label ? [arrangement.label] : [],
        salaryLabel: field(job.salary, 'label'),
        listedAt: { label: field(job.listedAt, 'label') },
        teaser: Array.isArray(job.products?.bullets) ? job.products.bullets.join(' · ') : undefined,
      }];
    });
  });

  return rows
    .map(normalise)
    .filter((job): job is JobListing => job !== null)
    .map((job) => ({ ...job, source: 'recommended' as const }));
}

/**
 * Search URL for one keyword and page.
 *
 * `where`/`distance` are only appended when a radius is actually configured,
 * so an unset radius produces exactly the URL this used to build. SEEK 308s
 * this query form to its canonical `/{role}-jobs/in-{Location}?distance=N`
 * path and applies the filter server-side (verified live).
 */
export function searchUrl(keywords: string, pageNum = 1): string {
  const params = new URLSearchParams({ keywords, sortmode: 'ListedDate' });
  const { location, radiusKm } = config.search;
  if (location && radiusKm > 0) {
    params.set('where', location);
    params.set('distance', String(radiusKm));
  }
  if (pageNum > 1) params.set('page', String(pageNum));
  return `${config.seekBase}/jobs?${params.toString()}`;
}

/** Primary path: pull the hydrated result set out of Apollo's cache. */
export async function searchViaApollo(page: Page, keywords: string, pageNum = 1): Promise<JobListing[]> {
  const url = searchUrl(keywords, pageNum);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-automation="normalJob"]', { timeout: 15_000 }).catch(() => {});
  await jitter(600, 1400);

  const raw = await page.evaluate(() => {
    const client = (window as any).__APOLLO_CLIENT__;
    if (!client?.cache?.extract) return null;
    const store = client.cache.extract();

    /**
     * Apollo normalises nested entities into `{__ref: "Type:id"}` pointers.
     * Resolve them (one level deep is enough for location/organisation) so the
     * caller sees whole objects instead of dangling references.
     */
    const deref = (value: any, depth = 0): any => {
      if (!value || typeof value !== 'object' || depth > 3) return value;
      if (Array.isArray(value)) return value.map((v) => deref(v, depth + 1));
      if (typeof value.__ref === 'string') return deref(store[value.__ref], depth + 1);
      const out: any = {};
      for (const k of Object.keys(value)) out[k] = deref(value[k], depth + 1);
      return out;
    };

    const root = store.ROOT_QUERY ?? {};
    const candidates = Object.keys(root)
      .filter((k) => /jobSearch/i.test(k))
      .map((k) => deref(root[k]));
    return JSON.stringify({ candidates, store: deref(store, 2) });
  });

  if (!raw) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  for (const candidate of parsed.candidates ?? []) {
    const arr = deepFindJobArray(candidate);
    if (arr?.length) {
      const jobs = arr.map(normalise).filter((j): j is JobListing => j !== null);
      if (jobs.length) return jobs;
    }
  }
  // Last resort inside the cache: scan the whole normalised store.
  const arr = deepFindJobArray(parsed.store);
  return arr ? arr.map(normalise).filter((j): j is JobListing => j !== null) : [];
}

/** Fallback: read the rendered cards via SEEK's own data-automation hooks. */
export async function searchViaDom(page: Page, keywords: string, pageNum = 1): Promise<JobListing[]> {
  const url = searchUrl(keywords, pageNum);
  if (!page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-automation="normalJob"]', { timeout: 15_000 }).catch(() => {});
  }

  const rows = await page.evaluate(() => {
    const out: any[] = [];
    document.querySelectorAll('[data-automation="normalJob"], article[data-job-id]').forEach((card) => {
      const id = card.getAttribute('data-job-id');
      if (!id) return;
      const txt = (sel: string) =>
        card.querySelector(`[data-automation="${sel}"]`)?.textContent?.trim() || undefined;
      out.push({
        id,
        title: txt('jobTitle') ?? card.getAttribute('aria-label') ?? '',
        company: txt('jobCompany') ?? 'Unknown',
        location: txt('jobCardLocation') ?? txt('jobLocation') ?? 'Unknown',
        salary: txt('jobSalary'),
        listedText: txt('jobListingDate'),
        workArrangement: txt('jobWorkArrangement'),
        teaser: txt('jobShortDescription'),
      });
    });
    return out;
  });

  return rows
    .filter((r) => r.id && r.title)
    .map((r) => ({
      id: String(r.id),
      title: r.title,
      company: r.company,
      location: r.location,
      workArrangement: r.workArrangement,
      salary: r.salary,
      listedAt: r.listedText,
      ageDays: parseAgeDays(r.listedText),
      url: `${config.seekBase}/job/${r.id}`,
      teaser: r.teaser,
      platform: 'seek' as const,
    }));
}

export async function search(page: Page, keywords: string, pageNum = 1): Promise<JobListing[]> {
  const viaApollo = await searchViaApollo(page, keywords, pageNum).catch(() => []);
  if (viaApollo.length) return viaApollo.map((job) => ({ ...job, source: 'search' as const }));
  console.warn(`  [discovery] Apollo cache empty for "${keywords}" p${pageNum} — using DOM`);
  return (await searchViaDom(page, keywords, pageNum)).map((job) => ({ ...job, source: 'search' as const }));
}

/** Opens the detail page for the full description (needed for scoring). */
export async function fetchJobDetail(page: Page, job: JobListing): Promise<JobListing> {
  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-automation="jobAdDetails"]', { timeout: 15_000 }).catch(() => {});

  // Short timeout on purpose: these fields are frequently absent, and the
  // 30s context default would otherwise cost minutes per listing.
  const pick = async (sel: string) =>
    (await page
      .locator(`[data-automation="${sel}"]`)
      .first()
      .innerText({ timeout: 1200 })
      .catch(() => '')) || undefined;

  const description = (await pick('jobAdDetails')) ?? '';
  const salary = (await pick('job-detail-salary')) ?? job.salary;
  const listedText = await pick('job-detail-date');
  const location = (await pick('job-detail-location')) ?? job.location;
  const work = (await pick('job-detail-work-type')) ?? job.workArrangement;

  /**
   * SEEK stamps "You applied on <date>" onto listings you have already applied
   * to — including applications made by hand, months ago, or on another device.
   * It is the only source that knows about those, so it is the authority for
   * dedupe rather than our own local history.
   */
  const applied = await page
    .evaluate(() => {
      const m = document.body.innerText.match(/[^\n]*\b(you applied|already applied)\b[^\n]*/i);
      return m ? m[0].trim().slice(0, 80) : null;
    })
    .catch(() => null);

  /**
   * SEEK's own profile-match callout on the detail page. Wording isn't
   * pinned down against a live listing as of this change (no signed-in
   * session was available to check it against) — this covers the phrasings
   * we could enumerate. If it never fires against a real "strong applicant"
   * listing, capture the exact text SEEK actually shows and tighten this.
   */
  const strongApplicant = await page
    .evaluate(() => {
      const m = document.body.innerText.match(
        /[^\n]*\byou(?:'d| would|'re| are)\b[^\n]{0,40}\b(strong applicant|strong candidate|great match|strong match)\b[^\n]*/i,
      );
      return m ? m[0].trim().slice(0, 160) : null;
    })
    .catch(() => null);

  return {
    ...job,
    description,
    salary,
    location,
    workArrangement: work,
    ageDays: job.ageDays ?? parseAgeDays(listedText),
    listedAt: job.listedAt ?? listedText,
    alreadyApplied: Boolean(applied),
    appliedNote: applied ?? undefined,
    strongApplicant: Boolean(strongApplicant),
    strongApplicantNote: strongApplicant ?? undefined,
  };
}
