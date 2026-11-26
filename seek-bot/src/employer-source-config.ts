/** Shared source contracts: configuration and access, never candidate-fit decisions. */
export const EMPLOYER_SOURCES = [
  { id: 'greenhouse', label: 'Greenhouse', key: 'GREENHOUSE_BOARDS', baseUrl: 'https://job-boards.greenhouse.io',
    defaults: 'theiconic,firmus,futuresecureai', kind: 'identifiers', help: 'Board identifiers from job-boards.greenhouse.io careers URLs.' },
  { id: 'workday', label: 'Workday', key: 'WORKDAY_SITES', baseUrl: 'https://myworkdayjobs.com',
    defaults: 'Nine|https://nine.wd105.myworkdayjobs.com/en-US/Nine_External_Career_Site,Garvan Institute|https://garvan.wd3.myworkdayjobs.com/en-US/garvan_institute',
    kind: 'urls', help: 'Known Workday career sites are included automatically. Add extra sites as Employer name|Workday career-site URL, separated by commas. Include the myworkdayjobs.com host, locale and career-site name.' },
] as const;

export type EmployerSourceId = typeof EMPLOYER_SOURCES[number]['id'];
/** @public Shared with the dashboard settings and run controls. */
export const EMPLOYER_SOURCE_DEFAULTS = Object.fromEntries(EMPLOYER_SOURCES.map(source => [source.key, source.defaults]));
export const isEmployerSource = (id: string): id is EmployerSourceId => EMPLOYER_SOURCES.some(source => source.id === id);
export const employerFeedsEnabled = (environment: Record<string, string | undefined>) => environment.EMPLOYER_FEEDS_ADMIN_ENABLED === 'true';

function workdayCareerSite(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('Use a public HTTPS career-site URL without credentials, query parameters or fragments.');
  const valid = /^[a-z0-9-]+\.wd\d{1,3}\.myworkdayjobs\.com$/.test(url.hostname) && /^\/[a-z]{2}-[A-Z]{2}\/[A-Za-z0-9_-]{1,100}\/?$/.test(url.pathname);
  if (!valid) throw new Error('Use the Workday career-site root shown in the example, rather than an individual job or a custom website.');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

export function employerTargets(id: EmployerSourceId, raw: string): string[] {
  const source = EMPLOYER_SOURCES.find(item => item.id === id)!;
  if (!source) throw new Error('This job source is no longer available.');
  const values = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))];
  if (!values.length || values.length > 20) throw new Error(`Choose 1–20 ${source.label} employers, separated by commas.`);
  return values.map(value => {
    if (source.kind === 'urls') {
      const target = workdayCareerTarget(value);
      return `${target.name ? `${target.name}|` : ''}${target.url.href}`;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(value)) throw new Error(`Use ${source.label} employer identifiers, not URLs.`);
    return value;
  });
}

export function workdayCareerTarget(raw: string): { name: string; url: URL } {
  const parts = raw.split('|');
  if (parts.length > 2 || (parts.length === 2 && (!parts[0].trim() || parts[0].length > 100))) throw new Error('Use Employer name|career-site URL.');
  return { name: parts.length === 2 ? parts[0].trim() : '', url: workdayCareerSite(parts.at(-1)!.trim()) };
}
