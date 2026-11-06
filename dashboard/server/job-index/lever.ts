import {parseHTML} from 'linkedom';
import {canonicalUrl,normaliseJob,plain} from './extract.js';

/** Only provider-owned public vacancy URLs can select a Lever API record. */
export function leverApiUrl(raw:string):string|null {
  const u=new URL(canonicalUrl(raw));
  const match=/^\/([a-z0-9_-]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(u.pathname);
  if(!match||!['jobs.lever.co','jobs.eu.lever.co'].includes(u.hostname))return null;
  return `https://${u.hostname==='jobs.eu.lever.co'?'api.eu.lever.co':'api.lever.co'}/v0/postings/${match[1]}/${match[2]}?mode=json`;
}

/** Bind fresh public API facts to the same vacancy's publisher HTML. A company
 * name comes from the publisher's title, never a search-agent suggestion. */
export function leverPublisherJob(html:string,url:string,raw:any) {
  const api=leverApiUrl(url);if(!api||!raw||Array.isArray(raw))return null;
  const canonical=canonicalUrl(url),id=new URL(canonical).pathname.split('/').at(-1);
  try{if(raw.id!==id||canonicalUrl(raw.hostedUrl)!==canonical)return null;}catch{return null;}
  const {document}=parseHTML(html),title=plain(raw.text,300);
  if(!title||![...document.querySelectorAll('h1,h2')].some(n=>plain(n.textContent,300)===title))return null;
  const pageTitle=plain(document.querySelector('meta[property="og:title"]')?.getAttribute('content')??document.querySelector('title')?.textContent,700);
  const suffix=` - ${title}`;
  if(!pageTitle.endsWith(suffix))return null;
  const company=pageTitle.slice(0,-suffix.length).trim();if(!company)return null;
  const locations=[...new Set([raw.categories?.location,...(Array.isArray(raw.categories?.allLocations)?raw.categories.allLocations:[])].filter((s):s is string=>typeof s==='string'&&!!s.trim()))];
  const description=[raw.opening??raw.openingPlain,raw.descriptionBody??raw.description??raw.descriptionPlain,...(Array.isArray(raw.lists)?raw.lists:[]).map((x:any)=>`${plain(x.text,300)}\n${typeof x.content==='string'?x.content:''}`),raw.additional??raw.additionalPlain].filter(v=>typeof v==='string').join('\n');
  const job=normaliseJob({title,hiringOrganization:{name:company},description,url:canonical,identifier:id,
    jobLocation:locations.map(name=>({name,...(typeof raw.country==='string'?{address:{addressCountry:raw.country}}:{})})),
    datePosted:typeof raw.createdAt==='number'&&Number.isFinite(raw.createdAt)?new Date(raw.createdAt).toISOString():undefined,
    workArrangement:raw.workplaceType==='on-site'?'onsite':raw.workplaceType},canonical,'lever');
  if(job)job.evidence.publisherApi=api;
  return job;
}
