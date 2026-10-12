/** Shared source contracts: configuration and access, never candidate-fit decisions. */
export const EMPLOYER_SOURCES = [
  { id: 'smartrecruiters', label: 'SmartRecruiters', key: 'SMARTRECRUITERS_COMPANIES', baseUrl: 'https://jobs.smartrecruiters.com',
    defaults: 'Canva,KPMGAustralia1,Colliers', kind: 'identifiers', help: 'Employer identifiers from SmartRecruiters careers URLs.' },
  { id: 'lever', label: 'Lever', key: 'LEVER_COMPANIES', baseUrl: 'https://jobs.lever.co',
    defaults: 'Objective Corporation|objective,Palantir Technologies|palantir,Kasada|kasada', kind: 'identifiers', help: 'Identifiers from jobs.lever.co. Optionally use Employer name|identifier to match the employer name used on other job boards.' },
  { id: 'greenhouse', label: 'Greenhouse', key: 'GREENHOUSE_BOARDS', baseUrl: 'https://job-boards.greenhouse.io',
    defaults: 'theiconic,firmus,futuresecureai', kind: 'identifiers', help: 'Board identifiers from job-boards.greenhouse.io careers URLs.' },
  { id: 'pageup', label: 'PageUp', key: 'PAGEUP_SITES', baseUrl: 'https://careers.pageuppeople.com',
    defaults: 'UNSW|https://careers.pageuppeople.com/841/cw/en,Built|https://careers.pageuppeople.com/1166/cw/en',
    kind: 'urls', help: 'Employer name|PageUp career-site URL, separated by commas. Use careers.pageuppeople.com roots; custom employer domains are not supported in this pilot.' },
  { id: 'workday', label: 'Workday', key: 'WORKDAY_SITES', baseUrl: 'https://myworkdayjobs.com',
    defaults: 'Nine|https://nine.wd105.myworkdayjobs.com/en-US/Nine_External_Career_Site,HUB24|https://hub24management.wd105.myworkdayjobs.com/en-US/HUB24_Careers,Garvan Institute|https://garvan.wd3.myworkdayjobs.com/en-US/garvan_institute',
    kind: 'urls', help: 'Employer name|Workday career-site URL, separated by commas. Include the myworkdayjobs.com host, locale and career-site name. Public career sites only.' },
] as const;

export type EmployerSourceId = typeof EMPLOYER_SOURCES[number]['id'];
export const EMPLOYER_SOURCE_DEFAULTS = Object.fromEntries(EMPLOYER_SOURCES.map(source => [source.key, source.defaults]));
export const isEmployerSource = (id: string): id is EmployerSourceId => EMPLOYER_SOURCES.some(source => source.id === id);
export const employerFeedsEnabled = (environment: Record<string, string | undefined>) => environment.EMPLOYER_FEEDS_ADMIN_ENABLED === 'true' || environment.SMARTRECRUITERS_ADMIN_ENABLED === 'true';

export function careerSite(source: 'pageup' | 'workday', raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('Use a public HTTPS career-site URL without credentials, query parameters or fragments.');
  const valid = source === 'pageup'
    ? url.hostname === 'careers.pageuppeople.com' && /^\/\d{1,8}\/[a-z]{2}\/en\/?$/.test(url.pathname)
    : /^[a-z0-9-]+\.wd\d{1,3}\.myworkdayjobs\.com$/.test(url.hostname) && /^\/[a-z]{2}-[A-Z]{2}\/[A-Za-z0-9_-]{1,100}\/?$/.test(url.pathname);
  if (!valid) throw new Error(`Use the ${source === 'pageup' ? 'PageUp' : 'Workday'} career-site root shown in the example, rather than an individual job or a custom website.`);
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

export function employerTargets(id: EmployerSourceId, raw: string): string[] {
  const source = EMPLOYER_SOURCES.find(item => item.id === id)!;
  const values = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))];
  if (!values.length || values.length > 20) throw new Error(`Choose 1–20 ${source.label} employers, separated by commas.`);
  return values.map(value => {
    if (source.kind === 'urls') {
      const target = careerTarget(id as 'pageup' | 'workday', value);
      return `${target.name ? `${target.name}|` : ''}${target.url.href}`;
    }
    if (id === 'lever') { const target = identifierTarget(value); return `${target.name ? `${target.name}|` : ''}${target.identifier}`; }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(value)) throw new Error(`Use ${source.label} employer identifiers, not URLs.`);
    return value;
  });
}

export function identifierTarget(raw: string): { name: string; identifier: string } {
  const parts = raw.split('|'); const identifier = parts.at(-1)!.trim();
  if (parts.length > 2 || (parts.length === 2 && (!parts[0].trim() || parts[0].length > 100)) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(identifier)) throw new Error('Use an employer identifier, optionally Employer name|identifier, not a URL.');
  return { name: parts.length === 2 ? parts[0].trim() : '', identifier };
}

export function careerTarget(id: 'pageup' | 'workday', raw: string): { name: string; url: URL } {
  const parts = raw.split('|');
  if (parts.length > 2 || (parts.length === 2 && (!parts[0].trim() || parts[0].length > 100))) throw new Error('Use Employer name|career-site URL.');
  return { name: parts.length === 2 ? parts[0].trim() : '', url: careerSite(id, parts.at(-1)!.trim()) };
}
