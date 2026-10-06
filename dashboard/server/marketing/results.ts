import { randomUUID } from 'node:crypto';
import type { ResultsSnapshot } from '../../src/marketingTypes.js';
import { samePublicSite as sameWebsite } from '../../../market-scout/src/core/public-url.js';

export function validDate(raw:unknown):string|null {return typeof raw==='string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(raw)) && new Date(raw).toISOString().slice(0,10)===raw?raw:null;}
export function measurementPeriod(body:Record<string,unknown>,now=Date.now()) {
  const start=validDate(body.periodStart),end=validDate(body.periodEnd);
  if(!start || !end || end<start || end>=new Date(now).toISOString().slice(0,10) || Date.parse(end)-Date.parse(start)>366*86400_000) throw new Error('Choose a completed measurement period of at most one year.');
  return {periodStart:start,periodEnd:end};
}
export function numberMetric(value:unknown,integer=false,signed=false):number|null {
  if(value===null || value===undefined || value==='') return null;
  const n=typeof value==='number'?value:typeof value==='string' && (signed?/^-?\d+(?:\.\d+)?$/:/^\d+(?:\.\d+)?$/).test(value.trim())?Number(value):NaN;
  if(!Number.isFinite(n) || (!signed && n<0) || Math.abs(n)>1e12 || (integer && !Number.isSafeInteger(n))) throw new Error('Metrics must be finite numbers; counts must be non-negative whole numbers.');
  return n;
}
export function emptySnapshot(source:ResultsSnapshot['source'],method:ResultsSnapshot['method'],period:{periodStart:string;periodEnd:string}):ResultsSnapshot {
  return {id:randomUUID(),source,method,...period,sourceLabel:'',timezone:'Unknown',recordedAt:new Date().toISOString(),clicks:null,impressions:null,ctr:null,position:null,sessions:null,organicSessions:null,aiSessions:null,keyEvents:null,leads:null,orders:null,revenue:null,currency:null,pages:[],queries:[],channels:[],aiSources:[],notes:[],previous:null};
}
export const AI_HOSTS=['chatgpt.com','chat.openai.com','perplexity.ai','gemini.google.com','copilot.microsoft.com','claude.ai'];
export const isAIReferrer=(source:string)=>AI_HOSTS.includes(source.toLowerCase().replace(/^www\./,''));
export function changePercent(current:number|null,previous:number|undefined):number|null {return current===null || previous===undefined || previous===0?null:(current-previous)/previous*100;}

/** RFC 4180-style quoted CSV, with bounded rows and strict header/column validation. */
export function parseCsv(text:string):string[][] {
  if(Buffer.byteLength(text,'utf8')>750_000) throw new Error('CSV is too large. Export at most 5,000 rows.');
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  const push=()=>{row.push(cell);cell='';closed=false;};
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) {if(c==='"') {if(text[i+1]==='"'){cell+='"';i++;}else {quoted=false;closed=true;}} else cell+=c;continue;}
    if(c==='"') {if(cell || closed) throw new Error('CSV contains malformed quoting.');quoted=true;continue;}
    if(c===',') {push();continue;}
    if(c==='\n' || c==='\r') {if(c==='\r' && text[i+1]==='\n') i++;push();if(row.some(v=>v.trim())) rows.push(row);row=[];if(rows.length>5001) throw new Error('Export at most 5,000 rows.');continue;}
    if(closed && c!==' ' && c!=='\t') throw new Error('CSV contains characters after a quoted cell.');
    if(!closed) cell+=c;
  }
  if(quoted) throw new Error('CSV contains an unclosed quoted cell.');
  push();if(row.some(v=>v.trim())) rows.push(row);
  if(rows.length<2 || rows.length>5001) throw new Error('Include a header and 1–5,000 data rows.');
  const header=rows[0].map(h=>h.replace(/^\uFEFF/,'').trim().toLowerCase());
  if(header.some(h=>!h) || new Set(header).size!==header.length || rows.some(r=>r.length!==header.length)) throw new Error('CSV headers must be unique and all rows must have matching columns.');
  rows[0]=header;return rows;
}
export function importResults(body:Record<string,unknown>,siteUrl:string):ResultsSnapshot {
  const period=measurementPeriod(body);const source=body.source;
  if(source!=='search-console' && source!=='ga4') throw new Error('Choose Search Console or GA4.');
  if(typeof body.csv!=='string' || typeof body.sourceLabel!=='string' || !body.sourceLabel.trim() || body.sourceLabel.length>200) throw new Error('Include a CSV and a source/property label.');
  const rows=parseCsv(body.csv),headers=rows.shift()!;
  const get=(row:string[],key:string)=>row[headers.indexOf(key)]?.trim();
  const snapshot=emptySnapshot(source,'import',period);snapshot.sourceLabel=body.sourceLabel.trim();snapshot.timezone=source==='search-console'?'America/Los_Angeles':typeof body.timezone==='string' && body.timezone.length<80?body.timezone:'Unknown';
  snapshot.notes=['Imported data supplied by the account owner; source authenticity, completeness and dates are not independently verified.','Totals cover only the supplied rows. Imports are separate snapshots and are never added to API totals.'];
  const required=source==='search-console'?['page','clicks','impressions']:['channel','source','sessions'];
  if(headers.includes('top pages') && !headers.includes('page')) headers[headers.indexOf('top pages')]='page';
  if(required.some(k=>!headers.includes(k))) throw new Error(`CSV needs these columns: ${required.join(', ')}.`);
  if(source==='search-console') {
    const seen=new Set<string>();let clicks=0,impressions=0,positionTotal=0,positionMeasured=true;
    for(const row of rows) {
      const url=get(row,'page') || '';try {const u=new URL(url);if(u.protocol!=='https:' || u.username || u.password || u.port || !sameWebsite(url,siteUrl)) throw new Error();} catch {throw new Error('Every imported page must be a public HTTPS URL on this website.');}
      if(seen.has(url)) throw new Error('Page rows must be unique; duplicate rows would double-count results.');seen.add(url);
      const c=numberMetric(get(row,'clicks'),true),n=numberMetric(get(row,'impressions'),true),p=numberMetric(get(row,'position'));
      if(c===null || n===null || c>n || (p!==null && p<1)) throw new Error('Check clicks, impressions and average position.');
      clicks+=c;impressions+=n;if(p!==null) positionTotal+=p*n;else if(n>0) positionMeasured=false;
      snapshot.pages.push({url,clicks:c,impressions:n,ctr:n?c/n:0,position:p});
    }
    snapshot.clicks=clicks;snapshot.impressions=impressions;snapshot.ctr=impressions?clicks/impressions:null;snapshot.position=positionMeasured && impressions?positionTotal/impressions:null;
    snapshot.pages.sort((a,b)=>b.impressions-a.impressions);snapshot.pages=snapshot.pages.slice(0,100);
  } else {
    let sessions=0,organic=0,ai=0;const channels=new Map<string,number>(),sources=new Map<string,number>(),seen=new Set<string>();
    for(const row of rows) {
      const channel=get(row,'channel') || '',source=get(row,'source') || '';const key=JSON.stringify([channel,source]);
      if(!channel || !source || channel.length>100 || source.length>200 || seen.has(key)) throw new Error('Channel/source rows must be non-empty and unique.');seen.add(key);
      const n=numberMetric(get(row,'sessions'),true);if(n===null) throw new Error('Each row needs a measured session count.');
      sessions+=n;if(channel.toLowerCase()==='organic search') organic+=n;if(isAIReferrer(source)){ai+=n;sources.set(source,(sources.get(source) || 0)+n);}
      channels.set(channel,(channels.get(channel) || 0)+n);
    }
    snapshot.sessions=sessions;snapshot.organicSessions=organic;snapshot.aiSessions=ai;snapshot.channels=[...channels].map(([name,sessions])=>({name,sessions}));snapshot.aiSources=[...sources].map(([name,sessions])=>({name,sessions}));snapshot.notes.push('AI sessions count recognized source domains only; missing referral information remains unattributed.');
  }
  return snapshot;
}
export function recordedResults(body:Record<string,unknown>):ResultsSnapshot {
  const result=emptySnapshot('manual','recorded',measurementPeriod(body));
  if(typeof body.sourceLabel!=='string' || !body.sourceLabel.trim() || body.sourceLabel.length>200) throw new Error('Name the analytics or sales record used for this measurement.');
  result.sourceLabel=body.sourceLabel.trim();
  for(const field of ['sessions','organicSessions','aiSessions','leads','orders','revenue'] as const) result[field]=numberMetric(body[field],field!=='revenue',field==='revenue');
  if(['sessions','organicSessions','aiSessions','leads','orders','revenue'].every(k=>result[k as 'sessions']===null)) throw new Error('Enter at least one measured result; leave unknown fields blank.');
  if(result.sessions!==null && ((result.organicSessions ?? 0)>result.sessions || (result.aiSessions ?? 0)>result.sessions)) throw new Error('Channel sessions cannot exceed total sessions.');
  const currency=typeof body.currency==='string'?body.currency.trim().toUpperCase():'';
  if(result.revenue!==null && !/^[A-Z]{3}$/.test(currency)) throw new Error('Revenue needs a three-letter currency.');
  result.currency=currency || null;result.notes=['Manually recorded from the named source; not independently verified. Unknown values remain blank.'];return result;
}
