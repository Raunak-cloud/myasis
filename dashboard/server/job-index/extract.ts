import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import {australianEligibility,declaredCountries} from './geography.js';
import type { EvidenceTag, IndexedJob, PreliminaryMatch, SearchProfile } from './types.js';

export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === 'string' && !!s.trim()).map(s => s.trim());
export function plain(v: unknown, limit = 60_000): string {
  if (typeof v !== 'string') return '';
  const { document } = parseHTML(`<main>${v.slice(0, 500_000)}</main>`);
  document.querySelectorAll('script,style,noscript').forEach(n => n.remove());
  document.querySelectorAll('br,p,li,div,h1,h2,h3').forEach(n => n.appendChild(document.createTextNode('\n')));
  return (document.querySelector('main')?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim().slice(0, limit);
}
export function canonicalUrl(raw: string): string {
  const u = new URL(raw); u.hash = '';
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !u.hostname.includes('.') || /^[\d.]+$|:|(^|\.)(?:localhost|local|internal|test|invalid|onion)\.?$/i.test(u.hostname) || u.href.length > 2000) throw Error('Only public HTTPS job addresses are accepted.');
  if([...u.searchParams.keys()].some(k=>/^(?:token|access_token|password|auth|authorization|session|sessionid|code|csrf)$/i.test(k)))throw Error('Authenticated and signed links are excluded.');
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|source$|tracking)/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort(); u.pathname = u.pathname.replace(/\/$/, '') || '/'; return u.href;
}
function date(v: unknown): string | null { return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null; }
const location = (v: any): string => typeof v === 'string' ? plain(v, 500) : plain([v?.address?.addressLocality, v?.address?.addressRegion, typeof v?.address?.addressCountry === 'object' ? v.address.addressCountry.name : v?.address?.addressCountry, v?.name].filter(Boolean).join(', '), 500);
const list = (v: any): any[] => v == null ? [] : Array.isArray(v) ? v : [v];
const tag = (value: string, evidence: string, basis: EvidenceTag['basis'] = 'source'): EvidenceTag => ({ value, evidence: evidence.slice(0, 500), basis });
const taxonomy: Array<[string, RegExp]> = [
  ['Software & IT', /\b(software|developer|devops|cyber|IT support|systems engineer|cloud engineer)\b/i],
  ['Data & analytics', /\b(data|analytics|statistician|machine learning|business intelligence)\b/i],
  ['Engineering', /\b(engineer|engineering|technician)\b/i],
  ['Finance & accounting', /\b(financ|accountant|accounting|payroll|bookkeeper|auditor)\w*/i],
  ['Administration & operations', /\b(administration|administrative|operations|coordinator|office manager)\b/i],
  ['Sales & marketing', /\b(sales|marketing|communications|advertising)\b/i],
  ['Customer service & retail', /\b(customer service|customer support|retail|store assistant|contact centre)\b/i],
  ['Healthcare', /\b(nurse|nursing|medical|healthcare|care worker|disability support|therapist)\b/i],
  ['Education', /\b(teacher|teaching|educator|lecturer|tutor)\b/i],
  ['Trades & logistics', /\b(electrician|plumber|carpenter|warehouse|driver|logistics|mechanic)\b/i],
  ['Hospitality', /\b(hospitality|chef|cook|barista|waiter|housekeeper)\b/i],
];
export const SKILLS = ['Python','JavaScript','TypeScript','Java','C++','C#','SQL','React','Node.js','AWS','Azure','GCP','Power BI','Tableau','Excel','SAP','Salesforce','Xero','MYOB','AutoCAD','Revit','SolidWorks','Figma','Docker','Kubernetes','Linux','Git','Project management','Customer service','Bookkeeping','Payroll','Data analysis','Machine learning','First aid','Forklift licence','Nursing','Teaching','Welding','Food safety','Inventory management','Stakeholder management','Procurement','Digital marketing'];
export const contains = (text: string, term: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text);
export function recognisedSkills(text: string): string[] { return SKILLS.filter(s => contains(text, s)); }

/** A missing fact stays unknown. Taxonomy inferred from a title is marked inferred. */
export function normaliseJob(raw: any, sourceUrl: string, source = 'structured-data', now = Date.now()): IndexedJob | null {
  const title = plain(raw?.title ?? raw?.name, 300), company = plain(typeof raw?.hiringOrganization === 'string' ? raw.hiringOrganization : raw?.hiringOrganization?.name, 300);
  const description = plain(raw?.description); const expiresAt = date(raw?.validThrough);
  if (!title || !company || description.length < 40 || (expiresAt && Date.parse(expiresAt) <= now)) return null;
  let url: string; try { url = canonicalUrl(typeof raw.url === 'string' ? raw.url : sourceUrl); } catch { return null; }
  const sourceId = plain(typeof raw.identifier === 'object' ? raw.identifier?.value : raw.identifier, 300);
  const evidence: Record<string, string> = {};
  let workArrangement: IndexedJob['workArrangement'] = 'not-mentioned';
  if (['remote','hybrid','onsite'].includes(raw.workArrangement)) {workArrangement=raw.workArrangement;evidence.workArrangement=`workArrangement: ${raw.workArrangement}`;}
  else if (strings(raw.jobLocationType).some(t => /^(TELECOMMUTE|REMOTE)$/i.test(t))) { workArrangement = 'remote'; evidence.workArrangement = `jobLocationType: ${raw.jobLocationType}`; }
  else {
    const text = `${title}\n${description}`;
    const arrangement = /\bhybrid(?: working| work| role| position| arrangement| model)?\b/i.exec(text)
      ?? /\b(?:fully remote|100% remote|remote (?:role|position|working|work)|work from home)\b/i.exec(text)
      ?? /\b(?:on[ -]?site (?:role|position|work|working)|office[ -]based|work on[ -]?site)\b/i.exec(text);
    if (arrangement && !/\b(?:not|no|non|cannot|can't|isn't|is not|does not)\W+(?:\w+\W+){0,2}$/i.test(text.slice(Math.max(0, arrangement.index - 35), arrangement.index))) {
      workArrangement = /hybrid/i.test(arrangement[0]) ? 'hybrid' : /site|office/i.test(arrangement[0]) ? 'onsite' : 'remote'; evidence.workArrangement = arrangement[0];
    }
  }
  const pay: IndexedJob['pay'] = { status: 'not-mentioned', min: null, max: null, currency: null, period: null, text: '' };
  const salary = raw.baseSalary, value = salary?.value;
  const number = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  if (salary && (number(value) !== null || number(value?.value) !== null || number(value?.minValue) !== null || number(value?.maxValue) !== null)) {
    Object.assign(pay, { status: 'disclosed', min: number(value?.minValue) ?? number(value?.value) ?? number(value), max: number(value?.maxValue) ?? number(value?.value) ?? number(value), currency: typeof salary.currency === 'string' && /^[A-Z]{3}$/.test(salary.currency) ? salary.currency : null, period: typeof value?.unitText === 'string' ? value.unitText : null, text: JSON.stringify(salary).slice(0, 1000) }); evidence.pay = pay.text;
  } else {
    const disclosed = /(?:A\$|AU\$|AUD\s*|USD\s*|NZD\s*|£|€|\$)\s*\d[\d,.]*(?:\s*[kK])?(?:\s*(?:–|-|to)\s*(?:(?:A?\$|AUD)\s*)?\d[\d,.]*\s*[kK]?)?(?:\s*(?:per |\/|a )?(?:hour|hr|annum|year|month|day|week|p\.?a\.?))?/i.exec(description);
    const context=disclosed?description.slice(Math.max(0,disclosed.index-60),disclosed.index+disclosed[0].length+60):'';
    if (disclosed && /\b(salary|pay|paid|remuneration|compensation|hour|hr|annum|year|month|day|week|p\.?a\.?)\b/i.test(context) && !/\b(training budget|learning budget|sign[- ]on bonus|referral bonus)\b/i.test(context)) { pay.status = 'disclosed'; pay.text = disclosed[0]; evidence.pay = disclosed[0]; }
    else { const unpaid = /\b(?:unpaid (?:role|position|internship|placement)|(?:this|the) (?:role|position|internship) is unpaid|volunteer (?:role|position))\b/i.exec(description); if (unpaid) { pay.status = 'unpaid'; pay.text = unpaid[0]; evidence.pay = unpaid[0]; } }
  }
  const tags: IndexedJob['tags'] = { categories: [], employmentTypes: [], seniority: [], suitableFor: [], skills: [], requirements: [] };
  for (const c of strings(raw.occupationalCategory)) tags.categories.push(tag(c.slice(0, 100), `occupationalCategory: ${c}`));
  if (!tags.categories.length) for (const [category, pattern] of taxonomy) if (pattern.test(title)) tags.categories.push(tag(category, title, 'inferred'));
  tags.employmentTypes = strings(raw.employmentType).slice(0, 10).map(v => tag(v.slice(0, 80), `employmentType: ${v}`));
  const level = /\b(intern|internship|graduate|junior|senior|lead|principal|manager|director|entry[ -]level|apprentice)\b/ig;
  tags.seniority = [...title.matchAll(level)].map(v => tag(v[0].toLowerCase(), title));
  const suits: Array<[string, RegExp]> = [['Graduates', /\b(?:recent graduates|graduates (?:welcome|encouraged)|graduate (?:program|role|position))\b/i], ['Entry level', /\b(?:entry[ -]level|no (?:prior )?experience (?:required|necessary))\b/i], ['Students', /\b(?:students (?:welcome|encouraged)|suitable for students|student placement)\b/i], ['Career changers', /\b(?:career changers? (?:welcome|encouraged)|suitable for career changers)\b/i]];
  for (const [label, pattern] of suits) { const m = pattern.exec(`${title}\n${description}`); if (m) tags.suitableFor.push(tag(label, m[0])); }
  const skillValues = [...new Set([...strings(raw.skills).flatMap(v => v.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)), ...recognisedSkills(description)])].slice(0, 60);
  tags.skills = skillValues.map(v => tag(v.slice(0, 100), strings(raw.skills).some(s => s.includes(v)) ? `skills: ${v}` : v));
  for (const field of ['educationRequirements','experienceRequirements','qualifications','eligibilityToWorkRequirement','securityClearanceRequirement']) {
    for (const v of list(raw[field])) { const text = plain(typeof v === 'string' ? v : v?.description ?? v?.credentialCategory, 500); if (text) tags.requirements.push(tag(field, text)); }
  }
  return { id: fingerprint(url), url, source, sourceId, title, company, description, locations: [...new Set(list(raw.jobLocation).map(location).filter(Boolean))], applicantLocations: [...new Set(list(raw.applicantLocationRequirements).map(location).filter(Boolean))], locationCountries:declaredCountries(raw.jobLocation),applicantLocationCountries:declaredCountries(raw.applicantLocationRequirements), postedAt: date(raw.datePosted), expiresAt, workArrangement, pay, tags, evidence };
}

/** Bounded JSON-LD graphs, not snippets or guessed listing titles. */
export function extractPage(html: string, sourceUrl: string, requireDeclaredUrl=false): { jobs: IndexedJob[]; links: string[]; closedUrls:string[] } {
  const { document } = parseHTML(html); const jobs = new Map<string, IndexedJob>(); const closedUrls:string[]=[];let visited = 0;
  // Transient search leads may only become persistent jobs when the publisher
  // independently supplies a job URL or a canonical page address.
  let declaredUrl='';
  const canonical=document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if(canonical)try{declaredUrl=canonicalUrl(new URL(canonical,sourceUrl).href);}catch{/* invalid publisher canonical */}
  const walk = (value: any, depth: number): void => {
    if (depth > 12 || ++visited > 5000 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.slice(0, 1000).forEach(v => walk(v, depth + 1)); return; }
    if (strings(value['@type']).some(t => /(?:^|\/)JobPosting$/.test(t))) { const job = normaliseJob(value, requireDeclaredUrl?declaredUrl:sourceUrl); if (job) jobs.set(job.id, job);else if(!requireDeclaredUrl&&typeof value.validThrough==='string'&&Date.parse(value.validThrough)<=Date.now())try{closedUrls.push(canonicalUrl(value.url??sourceUrl));}catch{/* malformed expired listing */} }
    for (const [key, v] of Object.entries(value)) if (key !== '@context') walk(v, depth + 1);
  };
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 50)) { try { walk(JSON.parse(script.textContent ?? ''), 0); } catch { /* malformed markup isn't a vacancy */ } }
  // SuccessFactors and other publishers expose schema.org microdata instead of
  // JSON-LD. Read properties inside their owning scope so an employer's HQ or
  // a related vacancy cannot supply this role's country, title or dates.
  const scopes=[...document.querySelectorAll('[itemscope][itemtype]')].filter(n=>/(?:^|\s|\/)JobPosting(?:\s|$)/.test(n.getAttribute('itemtype')??'')).slice(0,100);
  let properties=0;
  const microdata=(scope:any,depth=0):any=>{
    if(depth>8)return {};
    const value:Record<string,any>={};
    for(const node of [...scope.querySelectorAll('[itemprop]')] as any[]){
      if(++properties>5000)break;
      if(node.parentElement?.closest('[itemscope]')!==scope)continue;
      const names=(node.getAttribute('itemprop')??'').split(/\s+/).filter(Boolean);
      for(const name of names){
        if(!/^[A-Za-z][A-Za-z0-9]*$/.test(name)||['constructor','prototype','__proto__'].includes(name))continue;
        const item=node.hasAttribute('itemscope')?microdata(node,depth+1):node.getAttribute('content')??node.getAttribute('datetime')??(['A','LINK'].includes(node.tagName)?node.getAttribute('href'):null)??(name==='description'?node.innerHTML:node.textContent);
        value[name]=value[name]===undefined?item:Array.isArray(value[name])?[...value[name],item]:[value[name],item];
      }
    }
    return value;
  };
  for(const scope of scopes){
    const raw=microdata(scope);
    raw.jobLocation=list(raw.jobLocation).flatMap((place:any)=>Array.isArray(place?.address)?place.address.map((address:any)=>({...place,address})):place);
    const ownUrl=typeof raw.url==='string'?raw.url:scopes.length===1?(requireDeclaredUrl?declaredUrl:sourceUrl):'';
    const job=normaliseJob({...raw,url:ownUrl},ownUrl,'microdata');
    if(job&&!jobs.has(job.id))jobs.set(job.id,job);
    else if(typeof raw.validThrough==='string'&&Date.parse(raw.validThrough)<=Date.now())try{closedUrls.push(canonicalUrl(ownUrl));}catch{/* malformed publisher URL */}
  }
  const links: string[] = [];
  for (const a of [...document.querySelectorAll('a[href]')].slice(0, 500)) {
    try {
      const url = canonicalUrl(new URL(a.getAttribute('href')!, sourceUrl).href),u=new URL(url);
      const atsVacancy=(['jobs.lever.co','jobs.ashbyhq.com'].includes(u.hostname)&&/^\/[^/]+\/[a-f0-9-]{32,36}$/i.test(u.pathname))||(u.hostname==='jobs.smartrecruiters.com'&&/^\/[^/]+\/\d+-[^/]+$/.test(u.pathname));
      if((atsVacancy||/\b(career|careers|jobs?|vacanc|opportunit)/i.test(`${u.pathname} ${a.textContent}`))&&!/\/(?:login|sign[-_]?in|register|apply|application)(?:[/?]|$)/i.test(u.pathname))links.push(url);
    } catch { /* non-public/invalid link */ }
  }
  return { jobs: [...jobs.values()].slice(0, 300), links: [...new Set(links)].slice(0, 30), closedUrls:[...new Set(closedUrls)] };
}
export function matchJob(job: IndexedJob, p: SearchProfile): PreliminaryMatch | null {
  if(australianEligibility(job).status!=='eligible')return null;
  if (p.excludedCompanies.some(v => v.trim().toLowerCase() === job.company.toLowerCase())) return null;
  const keywords = p.keywords.filter(v => { const words = v.match(/[\p{L}\p{N}+#.]+/gu) ?? []; return words.length > 0 && words.every(w => contains(`${job.title}\n${job.description}`, w)); });
  const skills = p.skills.filter(v => contains(`${job.title}\n${job.description}`, v));
  // Skills can shortlist equivalent titles; the AI review still enforces the
  // user's requested job function, so incidental shared tools cannot admit jobs.
  if (!keywords.length && skills.length < 2) return null;
  if(p.arrangements.length&&job.workArrangement!=='not-mentioned'&&!p.arrangements.includes(job.workArrangement))return null;
  if(job.postedAt&&p.criteria?.maxAgeDays&&Date.parse(job.postedAt)<Date.now()-p.criteria.maxAgeDays*86400_000)return null;
  return { status: 'potential', keywords, skills, reasons: [...keywords.map(v => `Keyword: ${v}`), ...skills.map(v => `Resume/profile skill: ${v}`)], preferences: { arrangement: !p.arrangements.length ? 'compatible' : job.workArrangement === 'not-mentioned' ? 'unknown' : p.arrangements.includes(job.workArrangement) ? 'compatible' : 'different', location: p.location && job.locations.some(v => v.toLowerCase().includes(p.location.toLowerCase())) ? 'mentioned' : 'unknown' } };
}
