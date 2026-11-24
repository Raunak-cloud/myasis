import { query } from './db/index.js';
import { indexStore } from './job-index/config.js';
import { publicEmployerTarget, publicEmployerTargets } from '../../seek-bot/src/public-employer-directory.js';

type Catalog = { targets: () => Promise<string[]> };
type Options = { db?: typeof query; catalog?: Catalog | null };
type Candidate = { target: string; label: string };

/** Use known Greenhouse boards from settings, application history and the index. */
export async function expandedPublicEmployerSites(raw: string, options: Options = {}): Promise<string[]> {
  const db = options.db ?? query;
  const configured = publicEmployerTargets(raw.split(','));
  const rows = await db<{ url: string; company: string }>(`SELECT DISTINCT url,company FROM applications WHERE url LIKE '%greenhouse.io/%'
    UNION SELECT DISTINCT application_url AS url,company FROM applications WHERE application_url LIKE '%greenhouse.io/%'`);
  const settings = await db<{ value: string }>("SELECT DISTINCT value FROM settings WHERE key='GREENHOUSE_BOARDS'");
  const candidates: Candidate[] = rows.flatMap(row => {
    const target = publicEmployerTarget(row.url);
    return target ? [{ target, label: (row.company ?? '').replace(/[|,\r\n]/g, ' ').slice(0, 100) }] : [];
  });
  const include = (values: string[]) => {
    for (const target of publicEmployerTargets(values)) candidates.push({ target, label: '' });
  };
  include([...configured, ...settings.flatMap(row => row.value.split(','))]);
  try {
    let catalog = options.catalog;
    if (catalog === undefined) {
      const store = indexStore();
      catalog = store ? { targets: async () =>
        (await store.pool.query<{ target: string }>("SELECT DISTINCT payload->>'target' AS target FROM crawl_tasks WHERE kind='feed' AND payload->>'source'='greenhouse'")).rows.map(row => row.target) } : null;
    }
    if (catalog) include(await catalog.targets());
  } catch { /* Saved boards remain usable when the index is unavailable. */ }

  for (const { target, label } of candidates) await db(`INSERT INTO public_employer_directory(source,identity,target,label) VALUES('greenhouse',$1,$2,$3)
    ON CONFLICT(source,identity) DO UPDATE SET last_seen_at=now(),label=CASE WHEN public_employer_directory.label='' THEN excluded.label ELSE public_employer_directory.label END`,
    [target.toLowerCase(), target, label]);
  const saved = await db<{ target: string }>("SELECT target FROM public_employer_directory WHERE source='greenhouse' ORDER BY identity");
  return publicEmployerTargets([...configured, ...saved.map(row => row.target)]);
}
