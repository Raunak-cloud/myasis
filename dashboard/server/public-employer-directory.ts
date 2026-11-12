import { query } from './db/index.js';
import { indexConfig, indexStore } from './job-index/config.js';
import { safeKeywords } from './job-index/accounts.js';
import { EMPLOYER_SOURCES } from '../../seek-bot/src/employer-source-config.js';
import { publicEmployerTarget, publicEmployerTargets, publicDirectoryIdentity, type PublicDirectorySource } from '../../seek-bot/src/public-employer-directory.js';

type Catalog = { key?: string; reserveSearch: () => Promise<boolean>; targets: (source: PublicDirectorySource) => Promise<string[]> };
type Options = { db?: typeof query; network?: typeof fetch; catalog?: Catalog | null; now?: () => number };
type Candidate = { target: string; label: string };
export function publicEmployerCandidates(source: PublicDirectorySource, values: Array<{ url: string; company?: string }>): Candidate[] {
  const results = new Map<string, Candidate>();
  for (const value of values) {
    const target = publicEmployerTarget(source, value.url);
    const label=(value.company??'').replace(/[|,\r\n]/g,' ').slice(0,100);
    if (target && !results.has(publicDirectoryIdentity(target))) results.set(publicDirectoryIdentity(target), { target, label:/^PageUp employer \d+$/i.test(label)?'':label });
  }
  return [...results.values()];
}

/** Shared public metadata; existing global search allowance governs all providers and users. */
export async function expandedPublicEmployerSites(source: PublicDirectorySource, raw: string, keywords: string, discover = true, options: Options = {}): Promise<string[]> {
  const db = options.db ?? query, network = options.network ?? fetch;
  const spec = EMPLOYER_SOURCES.find(item => item.id === source)!;
  const configured = publicEmployerTargets(source, raw.split(','));
  const rows = await db<{ url: string; company: string }>(`SELECT DISTINCT url,company FROM applications WHERE url LIKE $1
    UNION SELECT DISTINCT application_url AS url,company FROM applications WHERE application_url LIKE $1`, [source === 'pageup' ? '%pageuppeople.com/%' : '%smartrecruiters.com/%']);
  const settings = await db<{ value: string }>('SELECT DISTINCT value FROM settings WHERE key=$1', [spec.key]);
  const savedTargets = settings.flatMap(row => publicEmployerTargets(source, row.value.split(',')));
  const candidates = publicEmployerCandidates(source, rows);
  const include = (values: string[]) => {
    for (const target of publicEmployerTargets(source, values)) candidates.push({ target: target.split('|').at(-1)!, label: target.includes('|') ? target.split('|')[0] : '' });
  };
  include([...configured, ...savedTargets]);
  let catalog = options.catalog;
  if (catalog === undefined) {
    const config = indexConfig(), store = config ? indexStore() : null;
    catalog = store ? { key: config?.braveKey, reserveSearch: () => store.reserveSearch(), targets: async id =>
      (await store.pool.query<{ target: string }>("SELECT DISTINCT payload->>'target' AS target FROM crawl_tasks WHERE kind='feed' AND payload->>'source'=$1", [id])).rows.map(row => row.target).filter(Boolean) } : null;
  }
  if (catalog) { try { include(await catalog.targets(source)); } catch { /* The shared index may be unavailable; saved companies remain usable. */ } }
  if (discover && catalog?.key) {
    const domain = source === 'pageup' ? 'careers.pageuppeople.com' : 'jobs.smartrecruiters.com';
    for (const term of ['', ...safeKeywords(keywords)].slice(0, 2)) {
      const text = `site:${domain} "Australia" ${term}`;
      const claim = await db('INSERT INTO public_employer_directory_searches(source,query) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING query', [source, text]);
      if (!claim.length) continue;
      const release = () => db('DELETE FROM public_employer_directory_searches WHERE source=$1 AND query=$2 AND day=current_date', [source, text]);
      try {
        if (!await catalog.reserveSearch()) { await release(); break; }
        const offset = Math.floor((options.now ?? Date.now)() / 86400_000) % 10;
        const search = async (page: number) => {
          const url = new URL('https://api.search.brave.com/res/v1/web/search');
          url.search = new URLSearchParams({ q: text, country: 'au', count: '20', offset: String(page) }).toString();
          const response = await network(url, { redirect: 'error', headers: { Accept: 'application/json', 'X-Subscription-Token': catalog!.key! }, signal: AbortSignal.timeout(12_000) });
          if (!response.ok) throw Error('Public employer discovery unavailable.');
          return (await response.json()).web?.results ?? [];
        };
        let results = await search(offset);
        if (!results.length && offset !== 0 && await catalog.reserveSearch()) results = await search(0);
        candidates.push(...publicEmployerCandidates(source, results.filter((row: any) => typeof row.url === 'string').map((row: any) => ({ url: row.url }))));
      } catch { await release(); }
    }
  }
  for (const candidate of candidates) await db(`INSERT INTO public_employer_directory(source,identity,target,label) VALUES($1,$2,$3,$4)
    ON CONFLICT(source,identity) DO UPDATE SET last_seen_at=now(),label=CASE WHEN public_employer_directory.label='' THEN excluded.label ELSE public_employer_directory.label END`,
    [source, publicDirectoryIdentity(candidate.target), candidate.target, candidate.label]);
  const saved = await db<Candidate>('SELECT target,label FROM public_employer_directory WHERE source=$1 ORDER BY identity', [source]);
  return publicEmployerTargets(source, [...configured, ...saved.map(row => row.label && source === 'pageup' ? `${row.label}|${row.target}` : row.target)]);
}
