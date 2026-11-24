import { query } from './db/index.js';
import { indexStore } from './job-index/config.js';
import { workdaySite, workdayDirectoryTargets } from '../../seek-bot/src/workday-directory.js';

type DirectoryCatalog = { targets: () => Promise<string[]> };
type DirectoryOptions = { db?: typeof query; catalog?: DirectoryCatalog | null };
type Candidate = { site: string; label: string };

export function workdayCandidates(values: Array<{ url: string; company?: string }>): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (const { url, company } of values) {
    const site = workdaySite(url);
    if (site && !candidates.has(site)) candidates.set(site, { site, label: (company ?? '').replace(/[|,\r\n]/g, ' ').slice(0, 100) });
  }
  return [...candidates.values()];
}

/** Use known public career sites from configuration, application history and the index. */
export async function expandedWorkdaySites(raw: string, options: DirectoryOptions = {}): Promise<string[]> {
  const db = options.db ?? query;
  const configured = workdayDirectoryTargets(raw.split(','));
  const candidates = configured.map(target => {
    const [label, site] = target.split('|');
    return site ? { site, label } : { site: label, label: '' };
  });
  const history = await db<{ url: string; company: string }>(`SELECT DISTINCT url,company FROM applications WHERE url LIKE '%myworkdayjobs.com/%'
    UNION SELECT DISTINCT application_url AS url,company FROM applications WHERE application_url LIKE '%myworkdayjobs.com/%'`);
  candidates.push(...workdayCandidates(history));
  try {
    let catalog = options.catalog;
    if (catalog === undefined) {
      const store = indexStore();
      catalog = store ? { targets: async () =>
        (await store.pool.query<{ target: string }>("SELECT DISTINCT payload->>'target' AS target FROM crawl_tasks WHERE kind='feed' AND payload->>'source'='workday'")).rows.map(row => row.target).filter(Boolean) } : null;
    }
    if (catalog) {
      const targets = await catalog.targets();
      candidates.push(...workdayCandidates(targets.map(target => ({ url: target.split('|').at(-1)! }))));
    }
  } catch { /* Known sites remain usable when the index is unavailable. */ }

  for (const { site, label } of candidates) await db(`INSERT INTO workday_directory(site,label) VALUES($1,$2)
    ON CONFLICT(site) DO UPDATE SET last_seen_at=now(),label=CASE WHEN workday_directory.label='' THEN excluded.label ELSE workday_directory.label END`, [site, label]);
  const saved = await db<Candidate>('SELECT site,label FROM workday_directory ORDER BY site');
  return workdayDirectoryTargets([...configured, ...saved.map(({ label, site }) => label ? `${label}|${site}` : site)]);
}
