import { parseHTML } from 'linkedom';
import { PublicCrawler, crawlUrl, type PageResponse } from '../job-index/network.js';

export interface HiringContact {
  email: string;
  name?: string;
  kind: 'hiring_manager' | 'recruitment';
  companyDomain: string;
  sourceUrl: string;
  sourceText: string;
  validatedAt: string;
}
export interface ContactSearchResult { url: string; title?: string; description?: string; extra_snippets?: string[] }
export type HiringContactSearch = (query: string, signal?: AbortSignal) => Promise<ContactSearchResult[]>;
export interface DiscoveryInput {
  company: string;
  website?: string;
  jobUrl?: string;
  previous?: HiringContact;
  signal?: AbortSignal;
}
export interface DiscoveryResult { contact: HiringContact | null; reason: string; pagesRead: number; retryable: boolean }
export interface DiscoveryOptions {
  crawler?: Pick<PublicCrawler, 'get'>;
  search?: HiringContactSearch;
  maxPages?: number;
  now?: () => Date;
}

const ATS = /(?:^|\.)(?:seek\.com(?:\.au)?|indeed\.com(?:\.au)?|jora\.com|adzuna\.com(?:\.au)?|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|pageuppeople\.com|smartrecruiters\.com|greenhouse\.io|lever\.co|ashbyhq\.com|successfactors\.(?:com|eu)|oraclecloud\.com|jobvite\.com|icims\.com|bamboohr\.com|applytojob\.com|workable\.com|recruitee\.com|breezy\.hr|jobadder\.com|taleo\.net|adp\.com|csod\.com|linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|google\.com)$/i;
const RECRUITING = /\b(?:recruit(?:ing|ment|er|ers)?|careers?|hiring|talent acquisition|people (?:and|&) culture|human resources|HR|job enquiries|employment enquiries|(?:send|submit|share|email).{0,35}(?:resumes?|CVs?|applications?))\b/i;
const FORBIDDEN = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|privacy|legal|abuse|security|webmaster|postmaster|media|press|investor|sales|support|help|billing)(?:[._+-]|$)/i;
const RECRUITING_LOCAL = /(?:^|[._+-])(?:hr|careers?|recruit(?:ment|ing)?|hiring|talent|jobs?|employment|resumes?|cvs?)(?:[._+-]|$)/i;
const EMAIL = /[a-z0-9.!#$%&'*+\/=^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;
const NO_EMAIL = /(?:do not|don't|cannot|can't|not to|not accept|no)\s+(?:send|email|accept|contact|submit|unsolicited|emailed)|(?:email|mailbox).{0,30}(?:not monitored|no longer|closed)/i;
const clean = (v: string) => v.replace(/\s+/g, ' ').trim();
const withoutVendorCredit = (v: string) => v.replace(/\b(?:recruitment|careers?|hiring)\s+(?:websites?|web\s+design|software)\s+(?:by|from)\b/gi,'Website vendor credit by');
const domain = (host: string) => host.toLowerCase().replace(/^www\d*\./, '').replace(/^(?:careers?|jobs|talent|people)\./, '');
const sameCompanyHost = (host: string, root: string) => host === root || host.endsWith(`.${root}`);
function publicUrl(raw: string): string | null {
  try { return crawlUrl(raw).href; } catch { return null; }
}
function isCompanyUrl(raw: string): boolean {
  const url = publicUrl(raw);
  return !!url && !ATS.test(new URL(url).hostname);
}
const words = (value: string) => value.normalize('NFKC').replace(/([a-z])([A-Z][a-z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const LEGAL = /^(?:pty|ltd|limited|inc|incorporated|llc|plc|corp|corporation)$/;
const REGION = /^(?:australia|australian|nsw|vic|qld|act|wa|sa|nt|tas|au|nz)$/;
const DESCRIPTION = /^(?:company|co|group|holdings?|international|it|professional|services|solutions|technolog(?:y|ies)|recruitment|recruiting)$/;
/** Publisher labels frequently append legal entities, office regions and an
 * industry description. These generate search/identity variants, never URLs. */
export function hiringCompanyBrand(company: string): string {
  const full = words(company).filter(v => !LEGAL.test(v));
  if (full[0] === 'the') full.shift();
  while (full.length > 1 && REGION.test(full.at(-1)!)) full.pop();
  const brand = [...full];
  while (brand.length > 1 && (DESCRIPTION.test(brand.at(-1)!) || REGION.test(brand.at(-1)!))) brand.pop();
  // "The Recruitment Company" is itself a brand, not an empty generic suffix.
  return (brand.some(v => !DESCRIPTION.test(v) && !REGION.test(v)) ? brand : full).join(' ');
}
function identityTokens(company: string): string[] { return words(hiringCompanyBrand(company)); }
function identifiesCompany(company: string, text: string): boolean {
  const tokens = identityTokens(company), normal = ` ${words(text.replace(EMAIL, '').replace(/https?:\/\/\S+/gi, '')).join(' ')} `;
  return tokens.length > 0 && tokens.every(t => normal.includes(` ${t} `));
}
function publisherNameMatches(company: string, publisher: string): boolean {
  const brand = identityTokens(company).join('');
  return !!brand && identityTokens(publisher).join('') === brand;
}
function companyDomainMatches(company: string, host: string): boolean {
  const brand = identityTokens(company).join('');
  return brand.length >= 3 && domain(host).split('.').some(part => {
    const value = identityTokens(part.replace(/-/g, ' ')).join('');
    return value === brand || ['group','holdings','international'].some(suffix => value === brand + suffix);
  });
}
function documentFor(html: string) {
  const { document } = parseHTML(`<html><body>${html.slice(0, 3_000_000)}</body></html>`);
  document.querySelectorAll('script,style,noscript,template,[hidden],[aria-hidden="true"]').forEach(n => n.remove());
  document.querySelectorAll('[style]').forEach(n => { if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.getAttribute('style') ?? '')) n.remove(); });
  document.querySelectorAll('title,br,p,li,div,h1,h2,h3,section').forEach(n => n.appendChild(document.createTextNode('\n')));
  return document;
}
function officialIdentity(company: string, doc: ReturnType<typeof documentFor>, host: string, linkedByEmployer: boolean, html = ''): boolean {
  const text = clean(doc.body?.textContent ?? '');
  if (!identifiesCompany(company, text)) return false;
  const siteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? '';
  const branding = [...doc.querySelectorAll('title,h1,header,[itemprop="name"]')].map(n => n.textContent ?? '').join(' ');
  // A directory mentioning an employer does not thereby become its website.
  // Search results need a matching brand domain or publisher site identity;
  // explicit employer-linked sites may instead confirm their own branding.
  if (companyDomainMatches(company,host) || publisherNameMatches(company,siteName) || linkedByEmployer && identifiesCompany(company,branding)) return true;
  const raw = parseHTML(`<html><body>${html.slice(0,3_000_000)}</body></html>`).document;
  for (const script of raw.querySelectorAll('script[type="application/ld+json"]')) {
    const queue: unknown[]=[];try{queue.push(JSON.parse(script.textContent??''));}catch{continue;}
    let count=0;while(queue.length&&count++<100){const value=queue.shift();if(Array.isArray(value)){queue.push(...value.slice(0,100));continue;}
      if(!value||typeof value!=='object')continue;const v=value as Record<string,unknown>;
      const types=Array.isArray(v['@type'])?v['@type']:[v['@type']];
      if(types.some(t=>['Organization','Corporation','EmploymentAgency','ProfessionalService'].includes(String(t)))&&typeof v.name==='string'&&publisherNameMatches(company,v.name)){
        for(const candidate of [v.url,...(Array.isArray(v.sameAs)?v.sameAs:[v.sameAs])])if(typeof candidate==='string'&&publicUrl(candidate)&&domain(new URL(candidate).hostname)===domain(host))return true;
      }
      if(Array.isArray(v['@graph']))queue.push(...v['@graph'].slice(0,100));
    }
  }
  return false;
}

/** A shared employer name alone cannot authorize sending to a cached company.
 * Direct employer URLs, publisher organisation metadata or an explicit employer
 * website link must associate the current vacancy with the cached domain. */
export async function canReuseHiringContact(company: string, jobUrl: string, contact: HiringContact, options: DiscoveryOptions & { signal?: AbortSignal } = {}): Promise<boolean> {
  options.signal?.throwIfAborted();
  const raw = publicUrl(jobUrl), rootUrl = `https://${contact.companyDomain}/`;
  if (!raw || !isCompanyUrl(rootUrl)) return false;
  const root = domain(new URL(rootUrl).hostname);
  if (isCompanyUrl(raw) && sameCompanyHost(new URL(raw).hostname, root)) return true;
  let page: PageResponse;
  try { page = await (options.crawler ?? new PublicCrawler(undefined, 8)).get(raw, { signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]) }); }
  catch (error) { if (options.signal?.aborted) throw error; return false; }
  if (!publicUrl(page.url) || page.status < 200 || page.status >= 300) return false;
  if (isCompanyUrl(page.url) && sameCompanyHost(new URL(page.url).hostname, root)) return true;
  const matchesDomain = (value: unknown): boolean => typeof value === 'string' && !!publicUrl(value) && sameCompanyHost(new URL(value).hostname, root);
  const rawDoc = parseHTML(`<html><body>${page.text.slice(0, 3_000_000)}</body></html>`).document;
  for (const script of rawDoc.querySelectorAll('script[type="application/ld+json"]')) {
    let json: unknown; try { json = JSON.parse(script.textContent ?? ''); } catch { continue; }
    const queue: unknown[] = [json]; let visited = 0;
    while (queue.length && visited++ < 100) {
      const item = queue.shift();
      if (Array.isArray(item)) { queue.push(...item.slice(0, 100)); continue; }
      if (!item || typeof item !== 'object') continue;
      const node = item as Record<string, unknown>, types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      if (types.includes('JobPosting')) {
        const org = node.hiringOrganization;
        if (org && typeof org === 'object' && !Array.isArray(org)) {
          const owner = org as Record<string, unknown>;
          if (typeof owner.name === 'string' && identifiesCompany(company, owner.name) && [owner.url, ...(Array.isArray(owner.sameAs) ? owner.sameAs : [owner.sameAs])].some(matchesDomain)) return true;
        }
      }
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph'].slice(0, 100));
    }
  }
  const doc = documentFor(page.text);
  if (!identifiesCompany(company, clean(doc.body?.textContent ?? ''))) return false;
  if (publishedHiringContacts(page.text, page.url, root, false).some(candidate => candidate.email.toLowerCase() === contact.email.toLowerCase())) return true;
  for (const anchor of doc.querySelectorAll('a[href]')) {
    let url: string; try { url = new URL(anchor.getAttribute('href')!, page.url).href; } catch { continue; }
    if (!matchesDomain(url)) continue;
    const label = clean(`${anchor.textContent ?? ''} ${anchor.getAttribute('aria-label') ?? ''}`);
    if (identifiesCompany(company, label) || /\b(?:company|employer|official|corporate) website\b/i.test(label)) return true;
  }
  return false;
}

/** Only visibly published recruitment contacts are candidates. Nothing is guessed or taken from scripts. */
export function publishedHiringContacts(html: string, sourceUrl: string, companyDomain: string, official: boolean, now = new Date(), company = ''): HiringContact[] {
  const document = documentFor(html);
  const publisher = clean([...document.querySelectorAll('title,h1')].map(n=>n.textContent??'').join(' '));
  const description=[...document.querySelectorAll('meta[name="description"],meta[property="og:description"]')].map(n=>n.getAttribute('content')??'').join(' ');
  const agencyEvidence=/\b(?:IT resourcing|professional resourcing|recruitment agency|recruitment consultan(?:cy|ts?)|technology recruitment|digital recruitment|introduction of a consultant|consultants?['’]?s?\s+hub)\b/i.exec(document.body?.textContent??'')?.[0]??'';
  const agencyPublisher = official && (/\brecruitment\b|\brecruiting (?:agency|specialists?|consultants?)\b/i.test(withoutVendorCredit(`${publisher} ${description} ${company}`))
    || !!agencyEvidence);
  const result = new Map<string, HiringContact & { score: number }>();
  const consider = (raw: string, context: string, explicitLink = false) => {
    const email = raw.toLowerCase().replace(/[.,;:]+$/, '');
    const [local, host, extra] = email.split('@');
    if (!host || extra || local.length > 64 || email.length > 254 || FORBIDDEN.test(local)) return;
    if (!official && !sameCompanyHost(host, companyDomain)) return;
    if (!RECRUITING.test(withoutVendorCredit(context)) && !RECRUITING_LOCAL.test(local)) {
      if(!agencyPublisher||!sameCompanyHost(host,companyDomain)&&!explicitLink)return;
      context=`${publisher}${agencyEvidence?`. ${agencyEvidence}`:''}. ${context}`;
    }
    if (NO_EMAIL.test(context)) return;
    const hiringManager = /\bhiring manager\b|\brecruit(?:ment|ing) (?:manager|partner)\b|\btalent acquisition (?:manager|partner)\b/i.test(context);
    const namedRecruiter = !RECRUITING_LOCAL.test(local) && /\b(?:recruitment|recruiting|talent acquisition) (?:consultant|partner|manager|lead|specialist|director)\b/i.test(context);
    const candidate = { email, kind: hiringManager && !RECRUITING_LOCAL.test(local) ? 'hiring_manager' as const : 'recruitment' as const,
      companyDomain, sourceUrl, sourceText: clean(context).slice(0, 600), validatedAt: now.toISOString(),
      score: (official ? 20 : 0) + (hiringManager||namedRecruiter ? 10 : 0) + (namedRecruiter&&/\b(?:principal|head|director)\b/i.test(context)?6:0) + (RECRUITING_LOCAL.test(local) ? 6 : 0) };
    if ((result.get(email)?.score ?? -1) < candidate.score) result.set(email, candidate);
  };
  for (const node of document.querySelectorAll('a[href^="mailto:"]')) {
    let raw: string;
    try { raw = decodeURIComponent((node.getAttribute('href') ?? '').slice(7).split('?')[0]); } catch { continue; }
    // A paragraph/list/card offers local context; a whole footer's careers link
    // must not turn an unrelated support email into a recruitment contact.
    const parent = node.closest('p,li,address,article,section') ?? node.parentElement;
    let context = clean(parent?.textContent ?? node.textContent ?? '').slice(0, 1200);
    if(!RECRUITING.test(context)){
      for(let ancestor=node.parentElement,depth=0;ancestor&&depth<4;ancestor=ancestor.parentElement,depth++){
        if(/^(?:BODY|HTML|MAIN|FOOTER|NAV|HEADER)$/.test(ancestor.tagName))break;
        const candidate=clean(ancestor.textContent??'');if(candidate.length>1200)break;
        if(RECRUITING.test(candidate)){context=candidate;break;}
      }
    }
    for (const match of raw.matchAll(EMAIL)) consider(match[0], context, true);
  }
  document.querySelectorAll('br,p,li,div,h1,h2,h3,section').forEach(n => n.appendChild(document.createTextNode('\n')));
  const text = (document.body?.textContent ?? document.textContent ?? '').replace(/\s*\[at\]\s*/gi, '@').replace(/\s*\[dot\]\s*/gi, '.');
  for (const match of text.matchAll(EMAIL)) {
    const at = match.index ?? 0, start = Math.max(text.lastIndexOf('\n', at) + 1, at - 220), newline = text.indexOf('\n', at);
    const end = Math.min(newline < 0 ? text.length : newline, at + match[0].length + 220);
    consider(match[0], text.slice(start, end));
  }
  return [...result.values()].sort((a, b) => b.score - a.score).map(({ score: _score, ...contact }) => contact);
}

/** The caller supplies the existing globally budgeted search reservation. */
export function createHiringContactSearch(options: { key: string; reserveSearch: () => Promise<boolean>; network?: typeof fetch }): HiringContactSearch {
  return async (query, signal) => {
    if (!options.key || !await options.reserveSearch()) throw Error('Public contact search is deferred until its search allowance is available.');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.search = new URLSearchParams({ q: query.slice(0, 500), country: 'au', count: '6',extra_snippets:'true' }).toString();
    const response = await (options.network ?? fetch)(url, { redirect: 'error', headers: { Accept: 'application/json', 'X-Subscription-Token': options.key }, signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw Error('Public contact search is temporarily unavailable.');
    const body = await response.json() as { web?: { results?: ContactSearchResult[] } };
    return (Array.isArray(body.web?.results) ? body.web.results : []).slice(0, 6).filter(v => typeof v?.url === 'string');
  };
}

/** Public pages only, bounded crawling, no account access, no email send and no execution of source instructions. */
export async function discoverHiringContact(input: DiscoveryInput, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  input.signal?.throwIfAborted();
  const crawler = options.crawler ?? new PublicCrawler(undefined, 40), maxPages = Math.min(16, Math.max(1, options.maxPages ?? 10));
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(input.signal ? [input.signal] : [])]);
  const now = (options.now ?? (() => new Date()))();
  let pagesRead = 0, accessFailures = 0;
  const seen = new Set<string>(), queue: string[] = [], employerLinked = new Set<string>();
  const priority=new Map<string,number>();
  const offices=[['nsw','sydney'],['vic','melbourne'],['qld','brisbane'],['wa','perth'],['sa','adelaide'],['act','canberra'],['tas','hobart'],['nt','darwin']];
  const companyWords=words(input.company),preferredOffice=offices.find(([state,city])=>companyWords.includes(state)||companyWords.includes(city))?.[1];
  const contactPriority=(value:string)=>preferredOffice&&new RegExp(`\\b${preferredOffice}\\b`,'i').test(value)?12:/\b(?:contact|office|branch|location|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin)\b/i.test(value)?6
    :/\b(?:about|team|people|consultant)\b/i.test(value)?5:/\b(?:career|careers|recruitment|talent|hiring)\b/i.test(value)?4:1;
  const relevantContact=(contacts:HiringContact[]):HiringContact|undefined=>contacts.find(c=>{
    if(!preferredOffice)return true;
    const office=offices.find(([,city])=>new RegExp(`\\b${city}\\b`,'i').test(`${c.email.split('@')[0]} ${new URL(c.sourceUrl).pathname}`))?.[1];
    return !office||office===preferredOffice;
  });
  const read = async (raw: string, optional = false): Promise<PageResponse | null> => {
    const url = publicUrl(raw);
    if (!url || seen.has(url) || pagesRead >= maxPages) return null;
    seen.add(url); pagesRead++;
    try { signal.throwIfAborted(); const page = await crawler.get(url, { signal });
      // Injected transports and every redirect still receive URL validation.
      if (!optional && (page.status === 408 || page.status === 429 || page.status >= 500)) accessFailures++;
      if (!publicUrl(page.url) || page.status < 200 || page.status >= 300 || !/html|text\/plain/.test(page.type)) return null;
      return page;
    } catch (error) { if (input.signal?.aborted) throw error; if(!optional)accessFailures++; return null; }
  };
  let searchCalls=0;const indexedSources:ContactSearchResult[]=[];
  const search = async (query: string) => {
    if (!options.search || signal.aborted) return [];
    if(++searchCalls>3){accessFailures++;return [];}
    try { const results=(await options.search(query, signal)).filter(r => publicUrl(r.url));indexedSources.push(...results);return results; }
    catch (error) { if (input.signal?.aborted) throw error; accessFailures++; return []; }
  };
  let root = '', jobPage: PageResponse | null = null;
  const previous = input.previous;
  if (previous && isCompanyUrl(`https://${previous.companyDomain}/`)) {
    root = domain(previous.companyDomain);
    const page = await read(previous.sourceUrl);
    if (page) {
      const official = sameCompanyHost(new URL(page.url).hostname, root);
      const contacts = publishedHiringContacts(page.text, page.url, root, official, now,input.company);
      const contact = relevantContact(contacts.filter(c => c.email.toLowerCase() === previous.email.toLowerCase()));
      let publisherConfirmed = official;
      if (!official && contacts.length) {
        const homepage = await read(`https://${root}/`);
        publisherConfirmed = !!homepage && sameCompanyHost(new URL(homepage.url).hostname, root)
          && officialIdentity(input.company, documentFor(homepage.text), new URL(homepage.url).hostname, false, homepage.text);
      }
      if (publisherConfirmed && identifiesCompany(input.company, clean(documentFor(page.text).body?.textContent ?? ''))) {
        if (contact) return { contact, reason: 'Previously published hiring contact revalidated.', pagesRead, retryable: false };
        const replacement=relevantContact(contacts);if (replacement) return { contact: replacement, reason: 'The public source now publishes a replacement hiring contact.', pagesRead, retryable: false };
      }
    }
    // Re-establish the publisher after a removed/changed source. A domain sale
    // must not turn last month's cache into authority for a different company.
    queue.push(`https://${root}/`);
    root = '';
  }
  for (const raw of [input.website, input.jobUrl]) if (raw && isCompanyUrl(raw)) { queue.push(raw); employerLinked.add(new URL(raw).origin); }
  // An ATS or job-board page is useful only for its outbound employer link.
  if (!queue.length && input.jobUrl) {
    const page = await read(input.jobUrl, true);
    if (page) {
      jobPage = page;
      const doc = documentFor(page.text);
      for (const link of doc.querySelectorAll('a[href]')) {
        try { const url = new URL(link.getAttribute('href')!, page.url).href;
          if (isCompanyUrl(url) && identifiesCompany(input.company, `${link.textContent ?? ''} ${link.getAttribute('aria-label') ?? ''} ${new URL(url).hostname.replace(/[.-]/g, ' ')}`)) { queue.push(url); employerLinked.add(new URL(url).origin); }
        } catch { /* malformed links are not candidates */ }
      }
      if (!queue.length && identifiesCompany(input.company, clean(doc.body?.textContent ?? ''))) {
        // A domain actually printed in a job's recruitment contact is evidence,
        // unlike a website domain invented from the employer's name. Its own
        // public page must still confirm the company before any contact is used.
        for (const contact of publishedHiringContacts(page.text, page.url, '', true, now,input.company)) {
          const host = contact.email.split('@')[1], url = `https://${host}/`;
          if (isCompanyUrl(url)) queue.push(url);
        }
      }
    }
  }
  const quotedCompany = input.company.replace(/["\r\n]/g, ' ').slice(0, 150);
  const brand = hiringCompanyBrand(input.company).slice(0,150);
  const indexedJobContact=():HiringContact|null=>{
    if(!root)return null;
    for(const result of indexedSources){
      const u=new URL(result.url),job=input.jobUrl&&publicUrl(input.jobUrl)?new URL(input.jobUrl):null;
      if(!/(^|\.)(?:indeed\.com(?:\.au)?|seek\.com(?:\.au)?)$/.test(u.hostname))continue;
      const snippets=(Array.isArray(result.extra_snippets)?result.extra_snippets:[]).filter(v=>typeof v==='string').slice(0,5);
      const text=clean(documentFor(`<p>${[result.title??'',result.description??'',...snippets].join('. ').slice(0,8000)}</p>`).body?.textContent??'');
      const exactJob=!!job&&((u.searchParams.get('jk')&&u.searchParams.get('jk')===job.searchParams.get('jk')&&/(^|\.)indeed\.com(?:\.au)?$/.test(job.hostname))
        ||(/\/job\/(\d+)/.exec(u.pathname)?.[1]&&/\/job\/(\d+)/.exec(u.pathname)?.[1]===/\/job\/(\d+)/.exec(job.pathname)?.[1]&&/(^|\.)seek\.com(?:\.au)?$/.test(job.hostname)));
      if(!exactJob&&!identifiesCompany(input.company,text))continue;
      const escaped=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const candidate=relevantContact(publishedHiringContacts(`<p>${escaped}</p>`,result.url,root,false,now,input.company));
      if(candidate)return {...candidate,sourceText:`Public search excerpt: ${candidate.sourceText}`.slice(0,600)};
    }
    return null;
  };
  const enqueueSearch=(results:ContactSearchResult[])=>queue.push(...results.filter(r=>isCompanyUrl(r.url)&&(!root||sameCompanyHost(new URL(r.url).hostname,root)))
    .sort((a,b)=>Number(companyDomainMatches(input.company,new URL(b.url).hostname))-Number(companyDomainMatches(input.company,new URL(a.url).hostname))).map(r=>r.url));
  let searched = false;
  if (!queue.length) { enqueueSearch(await search(`"${quotedCompany}" official company careers contact`)); searched = true; }
  const officialPages: PageResponse[] = [];
  const scanOfficial = async (reserveForFallback = false): Promise<HiringContact | null> => {
    while (queue.length && pagesRead < Math.max(2,maxPages-2) && !signal.aborted) {
      // Do not spend the entire budget on directories before the brand search,
      // nor fetch other companies after an official publisher is established.
      if(reserveForFallback&&!root&&pagesRead>=Math.max(2,maxPages-4))break;
      queue.sort((a,b)=>(priority.get(b)??contactPriority(new URL(b).pathname))-(priority.get(a)??contactPriority(new URL(a).pathname)));
      const target=queue.shift()!;
      if(root&&!sameCompanyHost(new URL(target).hostname,root))continue;
      const page = await read(target); if (!page || !isCompanyUrl(page.url)) continue;
      const doc = documentFor(page.text), host = new URL(page.url).hostname;
      if (root && !sameCompanyHost(host, root)) continue;
      if (!officialPages.length && !officialIdentity(input.company, doc, host, employerLinked.has(new URL(page.url).origin),page.text)) continue;
      root ||= domain(host); officialPages.push(page);
      const contacts = publishedHiringContacts(page.text, page.url, root, true, now,input.company);
      const relevant=relevantContact(contacts);if (relevant) return relevant;
      const next: Array<{ url: string; score: number }> = [];
      for (const link of doc.querySelectorAll('a[href]')) {
        try { const u = new URL(link.getAttribute('href')!, page.url); u.hash = '';
          const label = `${link.textContent ?? ''} ${u.pathname}`;
          if (isCompanyUrl(u.href) && sameCompanyHost(u.hostname, root) && /career|recruit|talent|hiring|contact|about|people|team|jobs|consultant|branch|office|location|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin/i.test(label)) next.push({ url: u.href, score: contactPriority(label) });
        } catch { /* malformed links are not candidates */ }
      }
      for(const entry of next){priority.set(entry.url,Math.max(priority.get(entry.url)??0,entry.score));if(!seen.has(entry.url)&&!queue.includes(entry.url))queue.push(entry.url);}
    }
    return null;
  };
  let contact = await scanOfficial(true);
  if (!contact && root && input.jobUrl && pagesRead < maxPages && !signal.aborted) {
    jobPage ??= await read(input.jobUrl,true);
    if (jobPage && identifiesCompany(input.company, clean(documentFor(jobPage.text).body?.textContent ?? ''))) {
      contact = relevantContact(publishedHiringContacts(jobPage.text, jobPage.url, root, false, now,input.company)) ?? null;
    }
  }
  if (!contact && (!searched || !root) && pagesRead < maxPages) {
    const results = await search(root?`${brand} site:${root} recruitment email`:`${brand} Australia recruitment contact official website`);
    if(!root)queue.length=0;
    enqueueSearch(results);
    contact = await scanOfficial();
  }
  if(!contact)contact=indexedJobContact();
  // A publicly indexed external page may corroborate a company-domain contact,
  // but never defines the company identity or authorizes an unrelated mailbox.
  if (!contact && root && pagesRead < maxPages && !signal.aborted) {
    const results = await search(`site:linkedin.com/company "${brand}" "@${root}" recruitment`);
    for (const result of results) {
      const page = await read(result.url);
      if(!page){
        // A public company-profile search excerpt is a separate attributed
        // source when its page blocks automated access. It may corroborate an
        // already verified employer domain, never establish one or guess mail.
        const url=new URL(result.url);let slug=/^\/company\/([^/]+)\/?$/.exec(url.pathname)?.[1];
        try{slug=slug?decodeURIComponent(slug):undefined;}catch{slug=undefined;}
        if(/(^|\.)linkedin\.com$/.test(url.hostname)&&slug&&publisherNameMatches(input.company,slug.replace(/-/g,' '))){
          const snippets=(Array.isArray(result.extra_snippets)?result.extra_snippets:[]).filter(v=>typeof v==='string').slice(0,5).map(v=>v.slice(0,1200));
          const text=clean(documentFor(`<p>${[result.title??'',result.description??'',...snippets].join('. ').slice(0,8000)}</p>`).body?.textContent??'').slice(0,8000);
          if(identifiesCompany(input.company,text)&&RECRUITING.test(text)){
            const escaped=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            const excerpt=publishedHiringContacts(`<p>${escaped}</p>`,result.url,root,false,now,input.company)[0];
            if(excerpt){contact={...excerpt,sourceText:`Public search excerpt: ${excerpt.sourceText}`.slice(0,600)};break;}
          }
        }
        continue;
      }
      const text = clean(documentFor(page.text).body?.textContent ?? '');
      if (!identifiesCompany(input.company, text)) continue;
      const contacts = publishedHiringContacts(page.text, page.url, root, sameCompanyHost(new URL(page.url).hostname, root), now,input.company);
      const relevant=relevantContact(contacts);if (relevant) { contact = relevant; break; }
    }
  }
  const retryable = !contact && (accessFailures > 0 || signal.aborted || queue.some(url => !seen.has(url)));
  return { contact, pagesRead, retryable, reason: contact ? 'Public hiring contact found.' : retryable ? 'Public contact lookup is incomplete or temporarily unavailable.' : officialPages.length ? 'The company pages do not publish a suitable hiring contact.' : 'The company website could not be verified from public sources.' };
}
