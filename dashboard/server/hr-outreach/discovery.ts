import { parseHTML } from 'linkedom';
import { PublicCrawler, CrawlBlocked, CrawlDeferred, crawlUrl, type PageResponse } from '../job-index/network.js';
import { canonicalUrl } from '../job-index/extract.js';

export interface HiringContact {
  email: string;
  name?: string;
  kind: 'hiring_manager' | 'recruitment';
  companyDomain: string;
  sourceUrl: string;
  sourceText: string;
  validatedAt: string;
  sourceKind?: 'public_page' | 'indexed_excerpt' | 'stored_vacancy';
}
export interface ContactSearchResult { url: string; title?: string; description?: string; extra_snippets?: string[] }
export type HiringContactSearch = (query: string, signal?: AbortSignal) => Promise<ContactSearchResult[]>;
export interface DiscoveryInput {
  company: string;
  website?: string;
  jobUrl?: string;
  previous?: HiringContact;
  signal?: AbortSignal;
  roleTitle?: string;
  location?: string;
  /** Server-owned public text from this exact jobUrl, not a model-provided company alias. */
  jobDescription?: string;
  jobDescriptionObservedAt?: string;
  /** Public mailboxes confirmed nonexistent by a correlated permanent bounce. */
  excludedEmails?: readonly string[];
}
export type DiscoveryOutcome = 'found' | 'no_contact' | 'company_unverified' | 'access_blocked' | 'temporarily_unavailable' | 'incomplete';
export type DiscoveryStage = 'revalidation' | 'employer_identity' | 'company_pages' | 'job_source' | 'public_sources';
export interface DiscoveryDiagnostics {
  stage: DiscoveryStage; searches: number; pagesAttempted: number; pagesRead: number; pagesBlocked: number; pagesFailed: number;
  candidatesRejected: number; unresolvedPriorityPages: number;
  events: Array<{ stage: DiscoveryStage; kind: string; url?: string; status?: number; detail: string }>;
}
export interface DiscoveryResult { contact: HiringContact | null; reason: string; pagesRead: number; retryable: boolean; outcome: DiscoveryOutcome; diagnostics: DiscoveryDiagnostics }
export interface DiscoveryOptions {
  crawler?: Pick<PublicCrawler, 'get'>;
  search?: HiringContactSearch;
  maxPages?: number;
  now?: () => Date;
}

const ATS = /(?:^|\.)(?:seek\.com(?:\.au)?|indeed\.com(?:\.au)?|jora\.com|adzuna\.com(?:\.au)?|freehire\.(?:me|com(?:\.au)?)|careerone\.com\.au|careerjet\.com(?:\.au)?|jooble\.org|jobrapido\.com|talent\.com|glassdoor\.com(?:\.au)?|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|pageuppeople\.com|smartrecruiters\.com|greenhouse\.io|lever\.co|ashbyhq\.com|successfactors\.(?:com|eu)|oraclecloud\.com|jobvite\.com|icims\.com|bamboohr\.com|applytojob\.com|workable\.com|recruitee\.com|breezy\.hr|jobadder\.com|taleo\.net|adp\.com|csod\.com|linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|google\.com)$/i;
const RECRUITING = /\b(?:recruit(?:ing|ment|er|ers)?|careers?|hiring|talent acquisition|people (?:and|&) culture|human resources|HR|job enquiries|employment enquiries|(?:send|submit|share|email).{0,35}(?:resumes?|CVs?|applications?))\b/i;
const FORBIDDEN = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|privacy|legal|abuse|security|webmaster|postmaster|media|press|investor|sales|support|help|billing)(?:[._+-]|$)/i;
const RECRUITING_LOCAL = /(?:^|[._+-])(?:hr|careers?|recruit(?:ment|ing)?|hiring|talent|jobs?|employment|resumes?|cvs?)(?:[._+-]|$)/i;
const RECRUITER_IDENTITY=/\b(?:talent acquisition|human resources|recruiter|recruitment (?:consultant|partner|manager|specialist|lead|director))\b/i;
const EMAIL = /[a-z0-9.!#$%&'*+\/=^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;
const NO_EMAIL = /(?:do not|don't|cannot|can't|not to|not accept|no)\s+(?:send|email|accept|contact|submit|unsolicited|emailed)|(?:email|mailbox).{0,30}(?:not monitored|no longer|closed)/i;
const NON_HIRING_CONTEXT = /\b(?:footy|football tipping|tipping competition|competition password|contest entry|giveaway|unsubscribe|newsletter|media enquiries|supplier registration)\b/i;
const clean = (v: string) => v.replace(/\s+/g, ' ').trim();
const excludedMailbox = (email:string, excluded: readonly string[] = []) => excluded.some(value=>value.trim().toLowerCase()===email.trim().toLowerCase());
const withoutVendorCredit = (v: string) => v.replace(/\b(?:recruitment|careers?|hiring)\s+(?:websites?|web\s+design|software)\s+(?:by|from)\b/gi,'Website vendor credit by');
const domain = (host: string) => host.toLowerCase().replace(/^www\d*\./, '').replace(/^(?:careers?|jobs|talent|people)\./, '');
const sameCompanyHost = (host: string, root: string) => host === root || host.endsWith(`.${root}`);
const OFFICES=[['nsw','sydney'],['vic','melbourne'],['qld','brisbane'],['wa','perth'],['sa','adelaide'],['act','canberra'],['tas','hobart'],['nt','darwin']];
function preferredHiringOffice(...evidence:string[]):string|undefined {
  for(const value of evidence){const tokens=words(value),office=OFFICES.find(([state,city])=>tokens.includes(state)||tokens.includes(city));if(office)return office[1];}
  return undefined;
}
function publishedContactOffice(contact:HiringContact):string|undefined {
  const value=`${contact.email.split('@')[0]} ${new URL(contact.sourceUrl).pathname}`;
  return OFFICES.find(([state,city])=>new RegExp(`\\b(?:${state}|${city})\\b`,'i').test(value))?.[1];
}
const roleAreas: Array<[string, RegExp]> = [
  ['technology', /\b(?:software|developer|devops|technology|digital|data|analytics|cyber|cloud|AI|information technology|infrastructure|systems|machine learning)\b/i],
  ['finance', /\b(?:finance|financial|accounting|accountant|treasury|audit|tax|payroll)\b/i],
  ['healthcare', /\b(?:nursing|nurse|healthcare|medical|clinical)\b/i],
  ['construction', /\b(?:construction|civil|structural|mechanical|electrical)\b/i],
];
const areaMatches = ([area, pattern]: [string,RegExp], value: string) => pattern.test(value) || area==='technology' && /\bIT\b/.test(value);
/** A sourced address is not automatically the right recipient for this role.
 * This assessment also audits old cached/sent evidence without a network call. */
export function assessHiringContact(contact: HiringContact, company: string, roleTitle = ''): { reviewRequired: boolean; reason: string | null } {
  const source = publicUrl(contact.sourceUrl), emailHost = contact.email.split('@')[1]?.toLowerCase() ?? '';
  if (!isCompanyUrl(`https://${contact.companyDomain}/`) || ATS.test(emailHost)) return { reviewRequired: true, reason: 'The published address belongs to a job platform, not this employer.' };
  if (!source || !company.trim() || !emailHost) return { reviewRequired: true, reason: 'The public contact evidence is incomplete.' };
  const evidence = contact.sourceText;
  const target = roleAreas.find(area => areaMatches(area,roleTitle))??(/\btechnical\b/i.test(roleTitle)?roleAreas[0]:undefined);
  const local = contact.email.split('@')[0];
  if(NON_HIRING_CONTEXT.test(evidence)&&!RECRUITING_LOCAL.test(local))return {reviewRequired:true,reason:'The published context concerns a competition, marketing or supplier service rather than recruitment.'};
  const personal = !RECRUITING_LOCAL.test(local) && !/^(?:info|hello|contact|enquiries|office|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin)(?:[._+-]|$)/i.test(local);
  const specialist = personal && /\b(?:speciali[sz](?:e|es|ed|ing|ation|ations)|market|practice|division|sector|focus(?:es|ed|ing)?|recruits?\s+(?:for|in)|covers?)\b/i.test(evidence);
  const areas = roleAreas.filter(area => areaMatches(area,evidence));
  if (target && specialist && areas.length && !areas.some(([area]) => area === target[0])) return { reviewRequired: true, reason: `The published recruiter specialises in ${areas.map(([area]) => area).join(' and ')}, while this application is a ${target[0]} role.` };
  return { reviewRequired: false, reason: null };
}
function publicUrl(raw: string): string | null {
  try { return crawlUrl(unquoteHref(raw)).href; } catch { return null; }
}
function unquoteHref(raw: string): string {
  return raw.trim().replace(/\\(["'])/g,'$1').replace(/&quot;|&#0*34;|&#x0*22;/gi,'"').replace(/^(?:["']|%22|%27)+|(?:["']|%22|%27)+$/gi,'').trim();
}
function resolvedHref(raw: string, base: string): URL { return new URL(unquoteHref(raw), base); }
function isCompanyUrl(raw: string): boolean {
  const url = publicUrl(raw);
  return !!url && !ATS.test(new URL(url).hostname) && !/(?:^|\.)(?:staging|stage|dev|test|preview|uat|sandbox)(?:[.-]|$)/i.test(new URL(url).hostname);
}
const words = (value: string) => value.normalize('NFKC').replace(/\bp\s*\/\s*l\b/gi, ' Pty Ltd ').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z])([A-Z][a-z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
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
function structuredNodes(html: string): Record<string, unknown>[] {
  const { document } = parseHTML(`<html><body>${html.slice(0, 3_000_000)}</body></html>`);
  const nodes: Record<string, unknown>[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const queue: unknown[] = []; try { queue.push(JSON.parse(script.textContent ?? '')); } catch { continue; }
    while (queue.length && nodes.length < 150) {
      const value = queue.shift(); if (Array.isArray(value)) { queue.push(...value.slice(0, 100)); continue; }
      if (!value || typeof value !== 'object') continue;
      const node = value as Record<string, unknown>; nodes.push(node);
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph'].slice(0, 100));
      if (['WebPage','AboutPage','ContactPage'].some(type=>hasType(node,type))) for(const child of [node.about,node.mainEntity]) if(child&&typeof child==='object')queue.push(child);
      for(const child of [node.isPartOf,node.publisher,node.parentOrganization]) if(child&&typeof child==='object')queue.push(child);
    }
  }
  return nodes;
}
const hasType = (node: Record<string, unknown>, type: string) => (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).includes(type);
function employerWebsites(html: string, company: string): string[] {
  const urls: string[] = [];
  for (const node of structuredNodes(html)) {
    if (!hasType(node, 'JobPosting')) continue;
    const owner = node.hiringOrganization;
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) continue;
    const org = owner as Record<string, unknown>;
    if (typeof org.name !== 'string' || !identifiesCompany(company, org.name)) continue;
    for (const value of [org.url, ...(Array.isArray(org.sameAs) ? org.sameAs : [org.sameAs])]) if (typeof value === 'string' && isCompanyUrl(value)) urls.push(value);
  }
  return [...new Set(urls)];
}
function officialIdentity(company: string, doc: ReturnType<typeof documentFor>, host: string, linkedByEmployer: boolean, html = ''): boolean {
  if (ATS.test(host)) return false;
  const text = clean(doc.body?.textContent ?? '');
  const siteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? '';
  const branding = [...doc.querySelectorAll('title,h1,header,[itemprop="name"]')].map(n => n.textContent ?? '').join(' ');
  const nodes = structuredNodes(html);
  const owners = nodes.filter(node => hasType(node, 'JobPosting')).map(node => node.hiringOrganization).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  const publisherNames=nodes.filter(node=>hasType(node,'WebSite')).map(node=>node.name).filter((name):name is string=>typeof name==='string');
  // A regional legal entity can publish under a parent trade brand. Require
  // its own named WebPage to reference the site's matching publisher, not an
  // employer merely mentioned by a directory's JobPosting/about metadata.
  const sameHost = (value: unknown) => typeof value==='string' && !!publicUrl(value) && domain(new URL(value).hostname)===domain(host);
  const ownsNamedPage = nodes.some(page => ['WebPage','AboutPage','ContactPage'].some(type=>hasType(page,type))
    && typeof page.name==='string' && identifiesCompany(company,page.name) && sameHost(page.url)
    && nodes.some(owner => ['Organization','Corporation','EmploymentAgency'].some(type=>hasType(owner,type)) && sameHost(owner.url)
      && typeof owner['@id']==='string' && typeof owner.name==='string' && identityTokens(owner.name)[0]?.length>=3 && identityTokens(owner.name)[0]===identityTokens(company)[0]
      && [page.about,page.mainEntity].some(ref=>!!ref&&typeof ref==='object'&&(ref as Record<string,unknown>)['@id']===owner['@id'])
      && nodes.some(site=>hasType(site,'WebSite')&&sameHost(site.url)&&!!site.publisher&&typeof site.publisher==='object'&&(site.publisher as Record<string,unknown>)['@id']===owner['@id'])));
  // A job publisher can repeat the employer's name and markup. Its own site
  // identity must not be mistaken for the organisation offering the vacancy.
  if (owners.length && !companyDomainMatches(company, host)
    && (new Set(owners.map(owner => String(owner.name ?? '').toLowerCase())).size > 1 || siteName && !publisherNameMatches(company, siteName) || publisherNames.some(name=>!publisherNameMatches(company,name)))) return false;
  if(!companyDomainMatches(company,host)&&publisherNames.some(name=>!publisherNameMatches(company,name))&&!linkedByEmployer&&!ownsNamedPage)return false;
  if (/\bhiring\??\s*(?:request access|join the network)|\btalent network\b/i.test(text) && !companyDomainMatches(company, host) && !publisherNameMatches(company, siteName)) return false;
  if(ownsNamedPage)return true;
  // A directory mentioning an employer does not thereby become its website.
  // Search results need a matching brand domain or publisher site identity;
  // explicit employer-linked sites may instead confirm their own branding.
  const ownLabel=siteName||doc.querySelector('title')?.textContent||doc.querySelector('h1')?.textContent||'';
  const ownBrand=identityTokens(ownLabel).filter(word=>!/^(?:about|contact|us|careers?|welcome|home|homepage|at|opportunities|jobs)$/.test(word));
  const matchingTradeBrand=identityTokens(company)[0]?.length>=3&&ownBrand[0]===identityTokens(company)[0];
  if (identifiesCompany(company,text) && (companyDomainMatches(company,host) || publisherNameMatches(company,siteName) && identifiesCompany(company,branding) || linkedByEmployer && matchingTradeBrand)) return true;
  for (const v of nodes) {
    if (['Organization','Corporation','EmploymentAgency','ProfessionalService'].some(type => hasType(v,type)) && typeof v.name === 'string' && publisherNameMatches(company,v.name)) {
      for (const candidate of [v.url,...(Array.isArray(v.sameAs)?v.sameAs:[v.sameAs])]) if (typeof candidate==='string' && isCompanyUrl(candidate) && domain(new URL(candidate).hostname)===domain(host)) return true;
    }
  }
  return false;
}

/** A shared employer name alone cannot authorize sending to a cached company.
 * Direct employer URLs, publisher organisation metadata or an explicit employer
 * website link must associate the current vacancy with the cached domain. */
export async function canReuseHiringContact(company: string, jobUrl: string, contact: HiringContact, options: DiscoveryOptions & Pick<DiscoveryInput,'signal'|'roleTitle'|'location'|'jobDescription'|'jobDescriptionObservedAt'|'excludedEmails'> = {}): Promise<boolean> {
  options.signal?.throwIfAborted();
  if(excludedMailbox(contact.email,options.excludedEmails))return false;
  if (assessHiringContact(contact, company, options.roleTitle).reviewRequired) return false;
  const wantedOffice=preferredHiringOffice(options.location??'',options.roleTitle??'',company),contactOffice=publishedContactOffice(contact);
  if(wantedOffice&&contactOffice&&wantedOffice!==contactOffice)return false;
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
    let url: string; try { url = resolvedHref(anchor.getAttribute('href')!, page.url).href; } catch { continue; }
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
  const pageUrl=new URL(sourceUrl);
  const careersPublisher=official&&/\b(?:careers?|job opportunities|experienced professionals)\b/i.test(`${publisher} ${description}`)
    && (/^(?:careers?|jobs|talent)\./i.test(pageUrl.hostname)||/\/(?:careers?|recruitment|jobs)(?:[/-]|$)/i.test(pageUrl.pathname));
  const generalAgencyContact=agencyPublisher&&/\/(?:contact(?:-us)?|branches?|offices?|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin)(?:[/-]|$)/i.test(pageUrl.pathname);
  const result = new Map<string, HiringContact & { score: number }>();
  const consider = (raw: string, context: string, explicitLink = false) => {
    const email = raw.toLowerCase().replace(/[.,;:]+$/, '');
    const [local, host, extra] = email.split('@');
    if (!host || extra || local.length > 64 || email.length > 254 || FORBIDDEN.test(local) || /^[*•●]+$/.test(local)) return;
    if (!official && !sameCompanyHost(host, companyDomain)) return;
    const unrelated=NON_HIRING_CONTEXT.test(context);
    if(unrelated&&!RECRUITING_LOCAL.test(local))return;
    if (!RECRUITING.test(withoutVendorCredit(context)) && !RECRUITING_LOCAL.test(local)) {
      const neutralMailbox=/^(?:info|hello|contact|enquiries|office|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin)(?:[._+-]|$)/i.test(local);
      const careerQuery=careersPublisher&&sameCompanyHost(host,companyDomain)&&/\b(?:queries|enquiries|questions|email|contact)\b/i.test(context);
      const agencyFallback=agencyPublisher&&(neutralMailbox||generalAgencyContact)&& (sameCompanyHost(host,companyDomain)||explicitLink);
      if(!careerQuery&&!agencyFallback)return;
      context=`${publisher}${agencyEvidence?`. ${agencyEvidence}`:''}. ${careerQuery?'Careers enquiries. ':''}${context}`;
    }
    if (NO_EMAIL.test(context)) return;
    const hiringManager = /\bhiring manager\b|\brecruit(?:ment|ing) (?:manager|partner)\b|\btalent acquisition (?:manager|partner)\b/i.test(context);
    const namedRecruiter = !RECRUITING_LOCAL.test(local) && /\b(?:recruitment|recruiting|talent acquisition) (?:consultant|partner|manager|lead|specialist|director)\b/i.test(context);
    const candidate = { email, kind: hiringManager && !RECRUITING_LOCAL.test(local) ? 'hiring_manager' as const : 'recruitment' as const,
      companyDomain, sourceUrl, sourceText: clean(context).slice(0, 600), validatedAt: now.toISOString(), sourceKind: 'public_page' as const,
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
  let pagesRead = 0, successfulPages = 0, searchCalls = 0, searchFailed = false, researchLimited = false, suppressedCandidates=0;
  let alternateLookup=!!input.previous&&excludedMailbox(input.previous.email,input.excludedEmails)&&!assessHiringContact(input.previous,input.company,input.roleTitle).reviewRequired;
  let root = '', jobPage: PageResponse | null = null;
  const escapedText=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const recordedJobPage=input.jobUrl&&publicUrl(input.jobUrl)&&input.jobDescription?.trim()?{url:publicUrl(input.jobUrl)!,text:`<h1>${escapedText(input.company)}</h1><p>${escapedText(input.jobDescription.slice(0,100_000))}</p>`}:null;
  const diagnostics: DiscoveryDiagnostics = { stage: 'employer_identity', searches: 0, pagesAttempted: 0, pagesRead: 0, pagesBlocked: 0, pagesFailed: 0, candidatesRejected: 0, unresolvedPriorityPages: 0, events: [] };
  const seen = new Set<string>(), queue: string[] = [], employerLinked = new Set<string>();
  const blocked = new Set<string>(), transient = new Set<string>();
  const priority=new Map<string,number>();
  const preferredOffice=preferredHiringOffice(input.location??'',input.roleTitle??'',input.company);
  const country=preferredOffice||/\b(?:australia|australian|au)\b/i.test(input.location??'')?'Australia':'';
  const careersContext=(value:string)=>/\b(?:career|careers|recruitment|talent|hiring)\b/i.test(value);
  const localCountry=(value:string)=>country&&/\baustralia(?:n)?\b|\b(?:en[-_]au|au[-_]en)\b/i.test(value);
  const contactPriority=(value:string)=>localCountry(value)&&careersContext(value)?13:preferredOffice&&new RegExp(`\\b${preferredOffice}\\b`,'i').test(value)&&(/\b(?:office|branch|contact|recruitment|careers?)\b/i.test(value)||new RegExp(`/${preferredOffice}/?$`,'i').test(value))?12:careersContext(value)?9:/\b(?:contact|office|branch|location|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin)\b/i.test(value)?6
    :/\b(?:team|people|consultant)\b/i.test(value)?5:/\babout\b/i.test(value)?3:1;
  const irrelevantPage=(url:URL,label='')=>!/career|recruit|talent|hiring|join[-\s]+(?:our[-\s]+)?team/i.test(`${url.hostname} ${url.pathname}`)
    && (/\/(?:blogs?|news|insights|articles|resources?|products?|solutions?|services?|insurance|events?|cookie|cookies|privacy|terms|for-you|for-employers|employer-join)(?:[/-]|$)/i.test(url.pathname)
      || /\/(?:partners?|customers?|discover-at-work|get-a-quote|book-a-demo)(?:[/-]|$)|\/locations\/(?:countries|cities|areas)\//i.test(url.pathname)
      || /\b(?:office[-\s]+(?:catering|meals|kitchen|event)|corporate[-\s]+catering|cup[-\s]+catering)\b/i.test(`${url.pathname} ${label}`)
      || /^(?:warranty|shop|store|members|support|help)\./i.test(url.hostname)
      || /\b(?:office catering|corporate catering|book a demo|cookie preferences|subscribe)\b/i.test(label));
  const event = (kind: string, detail: string, url?: string, status?: number) => {
    if (diagnostics.events.length >= 60) return;
    let safe: string | undefined; try { if (url && publicUrl(url)) { const u = new URL(url); safe = `${u.origin}${u.pathname}`.slice(0,500); } } catch { /* no unverified addresses in diagnostics */ }
    diagnostics.events.push({ stage: diagnostics.stage, kind, detail, ...(safe ? { url: safe } : {}), ...(status ? { status } : {}) });
  };
  const key = (url: string) => {
    const value=new URL(canonicalUrl(url));value.hostname=value.hostname.replace(/^www\d*\./,'');
    for(const name of [...value.searchParams.keys()])if(/^(?:locale|lang|language)$/i.test(name))value.searchParams.delete(name);
    return canonicalUrl(value.href);
  };
  const enqueue = (raw: string, score?: number) => {
    const url = publicUrl(raw); if (!url || irrelevantPage(new URL(url))) return;
    const identity = key(url); priority.set(identity, Math.max(priority.get(identity) ?? 0, score ?? contactPriority(new URL(url).pathname)));
    if (!seen.has(identity) && !queue.some(value => key(value) === identity)) queue.push(url);
  };
  const relevantContact=(contacts:HiringContact[]):HiringContact|undefined=>contacts.filter(c=>{
    if(excludedMailbox(c.email,input.excludedEmails)){if(root&&sameCompanyHost(c.email.split('@')[1]??'',root))alternateLookup=true;suppressedCandidates++;diagnostics.candidatesRejected++;event('contact_suppressed','This public mailbox was previously confirmed nonexistent and cannot be reused.',c.sourceUrl);return false;}
    const assessment = assessHiringContact(c,input.company,input.roleTitle);
    if (assessment.reviewRequired) { diagnostics.candidatesRejected++; event('contact_rejected',assessment.reason!,c.sourceUrl); return false; }
    if(!preferredOffice)return true;
    const office=publishedContactOffice(c);
    return !office||office===preferredOffice;
  }).sort((a,b)=>{
    const area = roleAreas.find(area=>areaMatches(area,input.roleTitle ?? ''));
    const score = (contact: HiringContact) => (area && areaMatches(area,contact.sourceText) ? 10 : 0) + (preferredOffice && new RegExp(`\\b${preferredOffice}\\b`,'i').test(`${contact.sourceText} ${contact.email}`) ? 5 : 0);
    return score(b)-score(a);
  })[0];
  const finish = (contact: HiringContact | null, successReason = 'Public hiring contact found.'): DiscoveryResult => {
    const pending = queue.filter(url => !seen.has(key(url)) && (!root || sameCompanyHost(new URL(url).hostname,root)) && (priority.get(key(url)) ?? 0)>=4);
    diagnostics.unresolvedPriorityPages=pending.length; diagnostics.searches=searchCalls; diagnostics.pagesAttempted=pagesRead; diagnostics.pagesRead=successfulPages;
    const relevant = (urls: Set<string>) => [...urls].some(url => root ? sameCompanyHost(new URL(url).hostname,root) : companyDomainMatches(input.company,new URL(url).hostname)||employerLinked.has(new URL(url).origin));
    const outcome: DiscoveryOutcome = contact ? 'found' : signal.aborted || researchLimited ? 'incomplete' : searchFailed || relevant(transient) ? 'temporarily_unavailable' : pending.length ? 'incomplete' : relevant(blocked) ? 'access_blocked' : root ? 'no_contact' : 'company_unverified';
    if (!contact && outcome==='incomplete') event('research_limit','Relevant public sources remain unchecked within this lookup limit.');
    const reasons: Record<DiscoveryOutcome,string> = { found:successReason, no_contact:'No suitable hiring contact was found on the public sources checked.', company_unverified:"The employer's official website could not be verified.", access_blocked:"The employer's public contact sources block automated access.", temporarily_unavailable:'Contact research could not finish because a network or search request failed.', incomplete:'Contact research reached its time, request or page limit before relevant sources were checked.' };
    return { contact, pagesRead, outcome, retryable: outcome==='temporarily_unavailable'||outcome==='incomplete', reason: reasons[outcome], diagnostics };
  };
  const read = async (raw: string, optional = false): Promise<PageResponse | null> => {
    const url = publicUrl(raw);
    if (!url || seen.has(key(url)) || pagesRead >= maxPages) return null;
    seen.add(key(url)); pagesRead++;
    try { signal.throwIfAborted(); const page = await crawler.get(url, { signal });
      if (!publicUrl(page.url)) { event('invalid_source','A redirect left the allowed public web.',url); return null; }
      if ([401,403].includes(page.status)) { diagnostics.pagesBlocked++; if(!optional)blocked.add(url); event('access_blocked','The public source refuses automated access.',url,page.status); return null; }
      if (page.status===408 || page.status===429 || page.status>=500) { diagnostics.pagesFailed++; if(!optional)transient.add(url); event('transient_error','The public source returned a temporary HTTP failure.',url,page.status); return null; }
      if (page.status<200||page.status>=300) { event('not_found','The public page was not found.',url,page.status);return null; }
      if (!/html|text\/plain/.test(page.type)) { event('unsupported_source','The public source is not an HTML or text contact page.',url,page.status);return null; }
      successfulPages++; event('page_read','Public page read.',page.url,page.status);
      return page;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : '';
      const code = (error as { code?: string })?.code;
      const localLimit = error instanceof CrawlDeferred && (crawler instanceof PublicCrawler && crawler.requests>crawler.maxRequests || error.waitMs<=60_000);
      const policy = error instanceof CrawlBlocked && /unsupported|3 MB|redirect limit|public internet|private|non-public|account and application|sign-in page/i.test(message);
      const permanent = error instanceof CrawlBlocked || /robots|verification|access denied|^blocked$/i.test(message);
      if (localLimit) { if(!optional)researchLimited=true;event('research_limit','Owtomate could not finish within this lookup request or pacing limit.',url); }
      else if(policy) { event('policy_refused','Owtomate could not use this source within its public-page size, redirect, type or security rules.',url); }
      else if (permanent) { diagnostics.pagesBlocked++; if(!optional)blocked.add(url); event('access_blocked',/robots/i.test(message)?'The source robots policy prevents this page read.':'The public source blocks automated access or requires verification.',url); }
      else {
        diagnostics.pagesFailed++; if(!optional)transient.add(url);
        const dns = ['ENOTFOUND','EAI_AGAIN','EAI_FAIL'].includes(code??'') || /\bDNS\b/i.test(message);
        const timeout = (error as { name?: string })?.name==='TimeoutError'||/timed?\s*out|timeout/i.test(message);
        event(dns?'dns_failure':timeout?'request_timeout':error instanceof CrawlDeferred?'source_deferred':'network_failure',dns?'Owtomate could not resolve the public source address.':timeout?'The public page request timed out.':error instanceof CrawlDeferred?'The source requires a later request.':'The public page request could not finish.',url);
      }
      return null;
    }
  };
  const indexedSources:ContactSearchResult[]=[];
  const search = async (query: string) => {
    if (!options.search || signal.aborted) return [];
    if(searchCalls>=3){event('research_limit','This lookup used its bounded search queries.');return [];}
    searchCalls++; event('search','Public employer/contact search requested.');
    try { const results=(await options.search(query, signal)).filter(r => publicUrl(r.url));indexedSources.push(...results);return results; }
    catch (error) { if (input.signal?.aborted) throw error; searchFailed=true;event('search_unavailable','The public search request could not finish.');return []; }
  };
  const previous = input.previous;
  if (previous && !assessHiringContact(previous,input.company,input.roleTitle).reviewRequired && isCompanyUrl(`https://${previous.companyDomain}/`)) {
    diagnostics.stage='revalidation';
    root = domain(previous.companyDomain);
    let currentPublisherEstablished=false;
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
        if (contact) return finish(contact,'Previously published hiring contact revalidated.');
        const replacement=relevantContact(contacts);if (replacement) return finish(replacement,'The public source now publishes a replacement hiring contact.');
        currentPublisherEstablished=official&&alternateLookup&&officialIdentity(input.company,documentFor(page.text),new URL(page.url).hostname,false,page.text);
      }
    }
    // Re-establish the publisher after a removed/changed source. A domain sale
    // must not turn last month's cache into authority for a different company.
    if(!currentPublisherEstablished){enqueue(`https://${root}/`,9);root = '';}
  } else if(previous) {
    diagnostics.candidatesRejected++;event('cached_contact_rejected','The cached public contact is not suitable for this employer and role.',previous.sourceUrl);
  }
  diagnostics.stage='employer_identity';
  for (const raw of [input.website, input.jobUrl]) if (raw && isCompanyUrl(raw)) { enqueue(raw,9); employerLinked.add(new URL(raw).origin); }
  if(recordedJobPage){
    // Masking the local part does not hide an explicitly printed employer
    // recruitment domain. It can lead to its public site, never invent a mail.
    for(const match of (input.jobDescription??'').matchAll(/@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})\b/gi)){
      const context=(input.jobDescription??'').slice(Math.max(0,(match.index??0)-180),(match.index??0)+match[0].length+100);
      const url=`https://${match[1].toLowerCase()}/`;
      if(RECRUITING.test(context)&&isCompanyUrl(url)){enqueue(url,8);employerLinked.add(new URL(url).origin);}
    }
  }
  // An ATS or job-board page is useful only for its outbound employer link.
  if (!queue.length && input.jobUrl) {
    const currentPage = await read(input.jobUrl, true);
    const page = currentPage ?? recordedJobPage;
    if (page) {
      if(currentPage)jobPage = currentPage;
      const doc = documentFor(page.text);
      for(const url of employerWebsites(page.text,input.company)){enqueue(url,10);employerLinked.add(new URL(url).origin);event('employer_link','The job names this employer website in hiringOrganisation data.',url);}
      for (const link of doc.querySelectorAll('a[href]')) {
        try { const url = resolvedHref(link.getAttribute('href')!, page.url).href;
          if (isCompanyUrl(url) && identifiesCompany(input.company, `${link.textContent ?? ''} ${link.getAttribute('aria-label') ?? ''} ${new URL(url).hostname.replace(/[.-]/g, ' ')}`)) { enqueue(url,9); employerLinked.add(new URL(url).origin); }
        } catch { /* malformed links are not candidates */ }
      }
      if (!queue.length && identifiesCompany(input.company, clean(doc.body?.textContent ?? ''))) {
        // A domain actually printed in a job's recruitment contact is evidence,
        // unlike a website domain invented from the employer's name. Its own
        // public page must still confirm the company before any contact is used.
        for (const contact of publishedHiringContacts(page.text, page.url, '', true, now,input.company)) {
          const host = contact.email.split('@')[1], url = `https://${host}/`;
          if (isCompanyUrl(url)) {enqueue(url,8);employerLinked.add(new URL(url).origin);}
        }
      }
    }
  }
  const quotedCompany = input.company.replace(/["\r\n]/g, ' ').slice(0, 150);
  const brand = hiringCompanyBrand(input.company).slice(0,150);
  const searchBrand=identityTokens(input.company).join('')===words(input.company).join('')?quotedCompany:brand;
  const recruitmentRemit=roleAreas.find(area=>areaMatches(area,input.roleTitle??''))?.[0]??(/\btechnical\b/i.test(input.roleTitle??'')?'technology':'');
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
      if(candidate){
        // A readable current vacancy is stronger evidence than an older index
        // excerpt. Do not restore an address removed from that actual page.
        if(exactJob&&jobPage&&identifiesCompany(input.company,clean(documentFor(jobPage.text).body?.textContent??''))&&!publishedHiringContacts(jobPage.text,jobPage.url,root,false,now,input.company).some(contact=>contact.email===candidate.email))continue;
        return {...candidate,sourceKind:'indexed_excerpt',sourceText:`Public search excerpt: ${candidate.sourceText}`.slice(0,600)};
      }
    }
    return null;
  };
  const enqueueSearch=(results:ContactSearchResult[])=>{
    for(const result of results.filter(r=>isCompanyUrl(r.url)&&(!root||sameCompanyHost(new URL(r.url).hostname,root)))
      .sort((a,b)=>Number(companyDomainMatches(input.company,new URL(b.url).hostname))-Number(companyDomainMatches(input.company,new URL(a.url).hostname)))) {
      const url=new URL(result.url),score=contactPriority(`${url.hostname} ${url.pathname} ${result.title??''}`);
      if(!irrelevantPage(url,result.title))enqueue(result.url,Math.max(companyDomainMatches(input.company,url.hostname)?8:0,score));
    }
  };
  if (!queue.length&&!root) enqueueSearch(await search(`"${quotedCompany}"${country?` ${country}`:''} official company careers contact`));
  const officialPages: PageResponse[] = [];
  const scanOfficial = async (reserveForFallback = false): Promise<HiringContact | null> => {
    diagnostics.stage=root?'company_pages':'employer_identity';
    while (queue.length && pagesRead < Math.max(2,maxPages-2) && !signal.aborted) {
      // Do not spend the entire budget on directories before the brand search,
      // nor fetch other companies after an official publisher is established.
      if(reserveForFallback&&!root&&pagesRead>=Math.max(2,maxPages-4))break;
      queue.sort((a,b)=>(priority.get(key(b))??contactPriority(new URL(b).pathname))-(priority.get(key(a))??contactPriority(new URL(a).pathname)));
      const target=queue.shift()!;
      if(seen.has(key(target)))continue;
      if(root&&!sameCompanyHost(new URL(target).hostname,root))continue;
      const page = await read(target); if (!page || !isCompanyUrl(page.url)) continue;
      const doc = documentFor(page.text), host = new URL(page.url).hostname;
      if (root && !sameCompanyHost(host, root)) continue;
      if (!officialPages.length && !officialIdentity(input.company, doc, host, employerLinked.has(new URL(page.url).origin),page.text)) { diagnostics.candidatesRejected++;event('identity_rejected','The page publisher could not be established as this employer.',page.url);continue; }
      root ||= domain(host); officialPages.push(page);
      if(input.jobUrl&&publicUrl(input.jobUrl)&&key(input.jobUrl)===key(target))jobPage=page;
      diagnostics.stage='company_pages';
      const contacts = publishedHiringContacts(page.text, page.url, root, true, now,input.company);
      const beforeSuppression=suppressedCandidates;
      const relevant=relevantContact(contacts);if (relevant) return relevant;
      const next: Array<{ url: string; score: number }> = [];
      for (const link of doc.querySelectorAll('a[href]')) {
        try { const u = resolvedHref(link.getAttribute('href')!, page.url); u.hash = '';
          const label = `${link.textContent ?? ''} ${u.pathname}`;
          const contactLink=/contact|about|people|team|consultant|branch|office|location/i.test(label);
          const roleArea=roleAreas.find(area=>areaMatches(area,input.roleTitle??''));
          const roleLink=!!roleArea&&areaMatches(roleArea,label);
          if(irrelevantPage(u,label))continue;
          const jobLeaf=/\/(?:jobs?|vacanc(?:y|ies)|opportunit(?:y|ies))\/[^/]+/i.test(u.pathname);
          if(jobLeaf&&!contactLink&&!roleLink)continue;
          if (isCompanyUrl(u.href) && sameCompanyHost(u.hostname, root) && /career|recruit|talent|hiring|contact|about|people|team|jobs|consultant|branch|office|location|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin/i.test(`${u.hostname} ${label}`)) next.push({ url: u.href, score: contactPriority(`${u.hostname} ${label}`)+(roleLink?7:0) });
        } catch { /* malformed links are not candidates */ }
      }
      for(const entry of next)enqueue(entry.url,entry.score);
      // Retain relevant links, but give alternative research a turn before
      // global navigation around a published dead inbox consumes the budget.
      if(suppressedCandidates>beforeSuppression||alternateLookup)return null;
    }
    return null;
  };
  let contact = await scanOfficial(true);
  if (root && input.jobUrl && (jobPage || pagesRead < maxPages) && !signal.aborted && (!contact || key(contact.sourceUrl)!==key(input.jobUrl))) {
    diagnostics.stage='job_source';
    jobPage ??= await read(input.jobUrl,true);
    const evidence=jobPage??recordedJobPage;
    if (evidence && identifiesCompany(input.company, clean(documentFor(evidence.text).body?.textContent ?? ''))) {
      const observedAt=input.jobDescriptionObservedAt&&new Date(input.jobDescriptionObservedAt);
      const observed=observedAt&&!Number.isNaN(observedAt.getTime())?observedAt:undefined;
      const found=relevantContact(publishedHiringContacts(evidence.text, evidence.url, root, false, jobPage?now:observed??now,input.company));
      if(found&&(jobPage||observed))contact=jobPage?found:{...found,sourceKind:'stored_vacancy'};
    }
  }
  if (!contact && pagesRead < maxPages && searchCalls<3) {
    diagnostics.stage=root?'company_pages':'employer_identity';
    const alternate=!!root&&alternateLookup;
    const results = await search(alternate?`site:linkedin.com "${searchBrand}"${country?` ${country}`:''}${recruitmentRemit?` ${recruitmentRemit}`:''} recruitment CV`:root?`${brand}${country?` ${country}`:''} site:${root} recruitment email`:`${brand}${country?` ${country}`:' Australia'} recruitment contact official website`);
    if(!root)queue.length=0;
    enqueueSearch(results);
    if(!alternateLookup||!options.search)contact = await scanOfficial();
  }
  if(!contact)contact=indexedJobContact();
  // A publicly indexed external page may corroborate a company-domain contact,
  // but never defines the company identity or authorizes an unrelated mailbox.
  if (!contact && root && pagesRead < maxPages && !signal.aborted) {
    diagnostics.stage='public_sources';
    const results = await search(alternateLookup?`site:linkedin.com/posts "${searchBrand}"${country?` ${country}`:''} recruitment resume`:input.roleTitle?`"${brand}" "${input.roleTitle.slice(0,150).replace(/["\r\n]/g,' ')}"${country?` ${country}`:''} recruitment email`:`site:linkedin.com/company "${brand}" "@${root}"${country?` ${country}`:''} recruitment`);
    contact=indexedJobContact();
    const isRecruiterPost=(raw:string)=>{const url=new URL(raw);return /(^|\.)linkedin\.com$/.test(url.hostname)&&/^\/posts\/[^/]+-activity-\d+-[^/]+\/?$/.test(url.pathname);};
    const isRecruiterProfile=(result:ContactSearchResult)=>{
      const url=new URL(result.url);
      const ownSummary=clean(documentFor(`<p>${result.description??''}</p>`).body?.textContent??'');
      return /(^|\.)linkedin\.com$/.test(url.hostname)&&/^\/in\/[^/]+\/?$/.test(url.pathname)
        &&identifiesCompany(input.company,(result.title??'').split(/\s[-–|]\s/).slice(1).join(' '))&&RECRUITER_IDENTITY.test(ownSummary);
    };
    const sourceResults=(alternateLookup?indexedSources:[...results,...indexedSources]).filter((result,index,all)=>all.findIndex(other=>key(other.url)===key(result.url))===index)
      .filter(result=>!alternateLookup||isRecruiterPost(result.url)||isRecruiterProfile(result)||/(^|\.)linkedin\.com$/.test(new URL(result.url).hostname)&&/^\/company\/[^/]+\/?$/.test(new URL(result.url).pathname))
      .sort((a,b)=>Number(isRecruiterPost(b.url))-Number(isRecruiterPost(a.url)));
    for (const result of sourceResults) {
      if(contact)break;
      const page = await read(result.url);
      if(!page){
        // A public company profile or explicit recruiter CV invitation can
        // corroborate an independently verified domain when access fails.
        // Preserve indexed provenance; the excerpt never establishes identity.
        const url=new URL(result.url);let slug=/^\/company\/([^/]+)\/?$/.exec(url.pathname)?.[1];
        try{slug=slug?decodeURIComponent(slug):undefined;}catch{slug=undefined;}
        if(/(^|\.)linkedin\.com$/.test(url.hostname)&&((slug&&publisherNameMatches(input.company,slug.replace(/-/g,' ')))||isRecruiterPost(result.url)||isRecruiterProfile(result))&&(blocked.has(publicUrl(result.url)!)||transient.has(publicUrl(result.url)!))){
          const snippets=(Array.isArray(result.extra_snippets)?result.extra_snippets:[]).filter(v=>typeof v==='string').slice(0,5).map(v=>v.slice(0,1200));
          const text=clean(documentFor(`<p>${[result.title??'',result.description??'',...snippets].join('. ').slice(0,8000)}</p>`).body?.textContent??'').slice(0,8000);
          const profile=!!slug;
          const cvInvitation=/\b(?:send|share|submit|email).{0,90}\b(?:CVs?|resumes?|profiles?|applications?)\b/i.test(text);
          const region=!country||/\b(?:australia(?:n)?|ANZ)\b/i.test(text)||!!preferredOffice&&new RegExp(`\\b${preferredOffice}\\b`,'i').test(text);
          if(identifiesCompany(input.company,text)&&RECRUITING.test(text)&&(profile||cvInvitation&&region)){
            const escaped=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            const excerpt=relevantContact(publishedHiringContacts(`<p>${escaped}</p>`,result.url,root,false,now,input.company));
            if(excerpt){contact={...excerpt,sourceKind:'indexed_excerpt',sourceText:`Public search excerpt: ${excerpt.sourceText}`.slice(0,600)};break;}
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
  if(!contact&&alternateLookup&&pagesRead<maxPages&&!signal.aborted)contact=await scanOfficial();
  return finish(contact);
}
