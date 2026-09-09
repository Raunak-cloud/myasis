import type { Page } from 'patchright';
import { config } from './config.js';
import { jitter, waitForChallengeToClear } from './browser.js';
import { judgePage, WALL_STATES } from './blocker.js';
import type { JobListing } from './types.js';

/**
 * How SEEK actually works (verified against the live site, Sep 2026):
 *
 * There is NO client-side JSON search endpoint to replay, and the page no
 * longer exposes its Apollo client on `window` — an earlier fast path read
 * the hydrated result set from there and now always came back empty. Results
 * are server-rendered, so the reader below uses SEEK's own `data-automation`
 * hooks, which are far stabler than CSS classes.
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
 * Reads the signed-in candidate's personalised SEEK Recommended feed from the
 * homepage's rendered cards, keyed on SEEK's `recommendedJobLink_<id>` hooks.
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
  await waitForChallengeToClear(page);
  await page
    .waitForSelector('[data-automation^="recommendedJobLink_"]', { timeout: 15_000 })
    .catch(() => {});
  await jitter(600, 1400);

  const rows: any[] = await page.evaluate(() => {
    const seen = new Set<string>();
    const out: any[] = [];
    document.querySelectorAll('[data-automation^="recommendedJobLink_"]').forEach((link) => {
      const href = link.getAttribute('href') ?? '';
      const id =
        link.getAttribute('data-automation')?.replace(/^recommendedJobLink_/, '') ||
        /\/job\/(\d+)/.exec(href)?.[1] ||
        '';
      if (!/^\d+$/.test(id) || seen.has(id)) return;
      seen.add(id);
      const card = link.closest('article, [data-job-id], li') ?? link;
      const txt = (sel: string) => card.querySelector(`[data-automation="${sel}"]`)?.textContent?.trim() || undefined;
      const title = txt('jobTitle') ?? link.getAttribute('aria-label') ?? link.textContent?.trim() ?? '';
      if (!title) return;
      out.push({
        id,
        title,
        companyName: txt('jobCompany') ?? txt('jobAdvertiser'),
        location: txt('jobCardLocation') ?? txt('jobLocation'),
        workArrangements: txt('jobWorkArrangement') ? [txt('jobWorkArrangement')] : [],
        salaryLabel: txt('jobSalary'),
        listedAt: { label: txt('jobListingDate') },
        teaser: txt('jobShortDescription'),
      });
    });
    return out;
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

/** Fallback: read the rendered cards via SEEK's own data-automation hooks. */
export async function searchViaDom(page: Page, keywords: string, pageNum = 1): Promise<JobListing[]> {
  const url = searchUrl(keywords, pageNum);
  if (!page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForChallengeToClear(page);
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
  const jobs = await searchViaDom(page, keywords, pageNum);
  // No cards is the only signal worth a model call: a wall, or simply no more results.
  if (!jobs.length && WALL_STATES.has((await judgePage(page, `SEEK search results for "${keywords}"`, { attemptSolve: false })).state)) {
    throw new Error('SEEK search requires human verification. Open SEEK login, complete verification, close that Chrome window and retry. No search results were evaluated.');
  }
  return jobs.map((job) => ({ ...job, source: 'search' as const }));
}

/** Mirrors SEEK's live CTA contract: Quick Apply is hosted; plain Apply leaves SEEK. */
export function classifySeekApplication(label?: string): JobListing['applicationMode'] {
  if (!label?.trim()) return 'unknown';
  const clean = label.replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/g, ' ').replace(/\s+/g, ' ').trim();
  return /quick\s*apply/i.test(clean) ? 'hosted' : 'external';
}

/** Opens the detail page for the full description (needed for scoring). */
export async function fetchJobDetail(page: Page, job: JobListing): Promise<JobListing> {
  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  await waitForChallengeToClear(page);
  await page.waitForSelector('[data-automation="jobAdDetails"]', { timeout: 15_000 }).catch(() => {});

  // Short timeout on purpose: these fields are frequently absent, and the
  // 30s context default would otherwise cost minutes per listing.
  const pick = async (sel: string) =>
    (await page
      .locator(`[data-automation="${sel}"]`)
      .first()
      .innerText({ timeout: 1200 })
      .catch(() => '')) || undefined;

  const applyCta = page.locator('[data-automation="job-detail-apply"]').first();
  const [detail, pay, listedText, place, workType, applyLabel, applyHref] = await Promise.all([
    pick('jobAdDetails'), pick('job-detail-salary'), pick('job-detail-date'),
    pick('job-detail-location'), pick('job-detail-work-type'),
    applyCta.innerText({ timeout: 1200 }).catch(() => ''),
    applyCta.getAttribute('href', { timeout: 1200 }).catch(() => null),
  ]);
  const description = detail ?? '';
  const salary = pay ?? job.salary;
  const location = place ?? job.location;
  const work = workType ?? job.workArrangement;
  const applicationMode = classifySeekApplication(applyLabel);
  const applicationUrl = applyHref
    ? (() => {
        try {
          return new URL(applyHref, page.url()).href;
        } catch {
          return undefined;
        }
      })()
    : undefined;

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
    applicationMode,
    applicationUrl,
  };
}
