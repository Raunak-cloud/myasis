import type {IndexedJob} from './types.js';

/** Versioned admission policy, shared by extraction consumers, AI and storage. */
export const AUSTRALIA_POLICY='australia-v1';
const list=(v:any):any[]=>v==null?[]:Array.isArray(v)?v:[v];
const text=(v:unknown):string=>typeof v==='string'?v.trim():'';
const normal=(v:string)=>v.normalize('NFKC').trim().toLowerCase();
const isAustralia=(v:string)=>['au','aus','036','australia','commonwealth of australia'].includes(normal(v));
const country=(v:any):string[]=>typeof v==='string'?[v]:typeof v==='number'?[String(v)]:v&&typeof v==='object'?[v.name,v.identifier,v['@id']].flatMap(x=>typeof x==='string'?[x]:[]):[];

/** Preserve explicit countries before flattening locations into display strings.
 * Country fields take precedence over a misleading city/name (e.g. Melbourne,
 * US). Never derive a country from a URL, currency, employer HQ or ad prose. */
export function declaredCountries(value:unknown):string[] {
  const walk=(v:any,depth:number):string[]=>{
    if(depth>5||!v||typeof v!=='object')return [];
    const direct=[...list(v.address).flatMap(a=>country(a?.addressCountry)),...country(v.addressCountry)];
    const types=list(v['@type']).map(text);
    if(types.some(t=>/(?:^|\/)Country$/.test(t)))direct.push(...country(v));
    return direct.length?direct:list(v.containedInPlace).flatMap(p=>walk(p,depth+1));
  };
  return [...new Set(list(value).flatMap(v=>walk(v,0)).map(text).filter(Boolean))];
}

// Display-only legacy/feed locations require an explicit country token. Bare
// cities/states, APAC and “remote” are ambiguous and deliberately stay unknown.
const australianLabel=(s:string)=>s.split(/[,;|/()\n]+/).some(t=>isAustralia(t));
export type AustralianEligibility={status:'eligible'|'excluded'|'unknown';evidence:string[]};
export function australianEligibility(job:Pick<IndexedJob,'locations'|'applicantLocations'|'workArrangement'|'locationCountries'|'applicantLocationCountries'>):AustralianEligibility {
  const locationCountries=job.locationCountries??[],applicantCountries=job.applicantLocationCountries??[];
  const locations=job.locations??[],applicants=job.applicantLocations??[];
  const physical=locationCountries.length?locationCountries.some(isAustralia):locations.some(australianLabel);
  const remote=applicantCountries.length?applicantCountries.some(isAustralia):applicants.some(australianLabel);
  // Explicit remote residence restrictions cannot be overridden by an Australian
  // office address, a keyword match or an AI's otherwise excellent fit score.
  if((applicantCountries.length||applicants.length)&&!remote)return {status:applicantCountries.length?'excluded':'unknown',evidence:[]};
  if(job.workArrangement==='remote'&&remote)return {status:'eligible',evidence:applicantCountries.length?applicantCountries:applicants};
  if(physical)return {status:'eligible',evidence:locationCountries.length?locationCountries:locations};
  return {status:locationCountries.length?'excluded':'unknown',evidence:[]};
}
