import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { one, query } from '../db/index.js';
import { readEnv } from '../runner.js';
import { marketingOrigin, MarketingError, ownedSite } from './store.js';
import { emptySnapshot, isAIReferrer, numberMetric } from './results.js';
import type { ResultsSnapshot } from '../../src/marketingTypes.js';
import { samePublicSite as sameWebsite } from '../../../market-scout/src/core/public-url.js';

const SCOPES=['https://www.googleapis.com/auth/webmasters.readonly','https://www.googleapis.com/auth/analytics.readonly'];
export function reportingConfig() {
  const env=readEnv();const clientId=process.env.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID ?? '',clientSecret=process.env.GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? '';
  const redirectUri=`${marketingOrigin()}/api/marketing/google/callback`;
  return {clientId,clientSecret,redirectUri,configured:Boolean(clientId && clientSecret)};
}
function tokenKey():Buffer {const c=reportingConfig();if(!c.clientSecret) throw new MarketingError('Google reporting is not configured.',503);return createHash('sha256').update(`owtomate-marketing-reporting-v1:${c.clientSecret}`).digest();}
export function encryptReportingToken(token:string):string {const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',tokenKey(),iv);const body=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),body].map(b=>b.toString('base64url')).join('.');}
export function decryptReportingToken(raw:string):string {const parts=raw.split('.').map(p=>Buffer.from(p,'base64url'));if(parts.length!==3 || parts[0].length!==12 || parts[1].length!==16) throw new MarketingError('Reconnect Google reporting.',409);const decipher=createDecipheriv('aes-256-gcm',tokenKey(),parts[0]);decipher.setAuthTag(parts[1]);return Buffer.concat([decipher.update(parts[2]),decipher.final()]).toString('utf8');}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const stateCookie=(state:string,maxAge=600)=>`marketing_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/marketing/; Max-Age=${maxAge}`;
function cookieState(header:string|undefined):string {const value=(header || '').split(';').map(p=>p.trim()).find(p=>p.startsWith('marketing_oauth='));return value?.slice('marketing_oauth='.length) || '';}

export async function beginReportingConnection(userId:string,siteId:string) {
  await ownedSite(userId,siteId);const c=reportingConfig();if(!c.configured) throw new MarketingError('Google reporting needs the Google OAuth client configured.',503);
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
  await query('DELETE FROM marketing_oauth_states WHERE expires_at<now()');
  await query("INSERT INTO marketing_oauth_states(state_hash,site_id,user_id,verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",[hash(state),siteId,userId,verifier]);
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [key,value] of Object.entries({client_id:c.clientId,redirect_uri:c.redirectUri,response_type:'code',scope:SCOPES.join(' '),access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'})) url.searchParams.set(key,value);
  return {url:url.href,cookie:stateCookie(state)};
}
export async function finishReportingConnection(userId:string,url:URL,cookie:string|undefined) {
  const state=url.searchParams.get('state') || '';
  if(!/^[\w-]{43}$/.test(state) || state!==cookieState(cookie)) throw new MarketingError('Google connection expired or did not match this browser. Try connecting again.');
  const pending=await one<{site_id:string;verifier:string}>('DELETE FROM marketing_oauth_states WHERE state_hash=$1 AND user_id=$2 AND expires_at>now() RETURNING site_id,verifier',[hash(state),userId]);
  if(!pending) throw new MarketingError('Google connection expired. Try connecting again.');
  await ownedSite(userId,pending.site_id);
  const code=url.searchParams.get('code');if(!code || url.searchParams.has('error')) return {siteId:pending.site_id,ok:false,cookie:stateCookie('',0)};
  const c=reportingConfig();
  const tokens=await providerRequest('https://oauth2.googleapis.com/token',undefined,new URLSearchParams({code,client_id:c.clientId,client_secret:c.clientSecret,redirect_uri:c.redirectUri,grant_type:'authorization_code',code_verifier:pending.verifier}));
  if(typeof tokens.refresh_token!=='string' || !tokens.refresh_token) throw new MarketingError('Google did not provide offline access. Reconnect and grant read-only reporting access.');
  const scope=typeof tokens.scope==='string'?tokens.scope:'';
  if(!SCOPES.some(s=>scope.split(' ').includes(s))) throw new MarketingError('Google reporting access was not granted.');
  await query(`INSERT INTO marketing_google_connections(site_id,user_id,encrypted_token,scope) VALUES($1,$2,$3,$4)
    ON CONFLICT(site_id) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,scope=EXCLUDED.scope,search_property=NULL,ga_property=NULL,daily_sync=false,next_sync_at=NULL,error=NULL,connected_at=now()`,[pending.site_id,userId,encryptReportingToken(tokens.refresh_token),scope]);
  return {siteId:pending.site_id,ok:true,cookie:stateCookie('',0)};
}
export async function reportingConnection(userId:string,siteId:string) {
  const row=await one('SELECT search_property,ga_property,daily_sync,last_sync_at,error FROM marketing_google_connections WHERE site_id=$1 AND user_id=$2',[siteId,userId]);const c=reportingConfig();
  return {connected:Boolean(row),configured:c.configured,searchProperty:row?.search_property || null,gaProperty:row?.ga_property || null,dailySync:row?.daily_sync || false,lastSyncAt:row?.last_sync_at?new Date(row.last_sync_at).toISOString():null,error:row?.error || null,redirectUri:c.redirectUri};
}
async function providerRequest(url:string,access?:string,body?:unknown):Promise<Record<string,any>> {
  const form=body instanceof URLSearchParams;
  for(let attempt=0;attempt<3;attempt++) {
    let response:Response;
    try {response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{...(access?{Authorization:`Bearer ${access}`} : {}),...(body!==undefined?{'Content-Type':form?'application/x-www-form-urlencoded':'application/json'}:{})},...(body===undefined?{}:{body:form?body.toString():JSON.stringify(body)}),signal:AbortSignal.timeout(25_000),redirect:'error'});} catch {throw new MarketingError('Google reporting could not be reached. Retry later.',503);}
    if((response.status===429 || response.status>=500) && attempt<2) {await response.body?.cancel();await new Promise(r=>setTimeout(r,1000*(attempt+1)));continue;}
    if(!response.ok) {await response.body?.cancel();throw new MarketingError(response.status===401?'Reconnect Google reporting.':response.status===403?'Google reporting access was refused. Check property access and that the Search Console, Analytics Data and Analytics Admin APIs are enabled.':response.status===400?'Google rejected the reporting request. Check your property settings.':'Google reporting is temporarily unavailable.',response.status>=500?503:409);}
    const text=await response.text();if(text.length>4_000_000) throw new MarketingError('Google report exceeded the response limit.',503);
    try {return JSON.parse(text);} catch {throw new MarketingError('Google returned an invalid report.',503);}
  }
  throw new MarketingError('Google reporting is temporarily unavailable.',503);
}
async function reportingAccess(userId:string,siteId:string) {
  const row=await one('SELECT encrypted_token,scope FROM marketing_google_connections WHERE site_id=$1 AND user_id=$2',[siteId,userId]);if(!row) throw new MarketingError('Connect Google reporting first.',409);
  let token:string;try {token=decryptReportingToken(row.encrypted_token);} catch {throw new MarketingError('Reconnect Google reporting; its stored credentials could not be opened.',409);}
  const c=reportingConfig();const refreshed=await providerRequest('https://oauth2.googleapis.com/token',undefined,new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,refresh_token:token,grant_type:'refresh_token'}));
  if(typeof refreshed.access_token!=='string') throw new MarketingError('Reconnect Google reporting.',409);
  return {access:refreshed.access_token as string,scope:row.scope as string};
}
export function searchPropertyMatches(property:string,siteUrl:string):boolean {
  const host=new URL(siteUrl).hostname.replace(/^www\./,'');
  if(property.startsWith('sc-domain:')) {const domain=property.slice(10).toLowerCase();return /^[a-z0-9.-]+$/.test(domain) && (host===domain || host.endsWith(`.${domain}`));}
  try {const u=new URL(property);return u.protocol==='https:' && sameWebsite(property,siteUrl) && u.pathname==='/';} catch{return false;}
}
async function listPages(url:string,access:string,key:string) {
  const list:Array<Record<string,any>>=[];let pageToken='';
  for(let i=0;i<5;i++) {const target=new URL(url);target.searchParams.set('pageSize','200');if(pageToken) target.searchParams.set('pageToken',pageToken);const value=await providerRequest(target.href,access);list.push(...(Array.isArray(value[key])?value[key]:[]));pageToken=typeof value.nextPageToken==='string'?value.nextPageToken:'';if(!pageToken) return list;}
  throw new MarketingError('Google returned too many properties. Use imports or reduce property access.',409);
}
export async function availableProperties(userId:string,siteId:string) {
  const site=await ownedSite(userId,siteId),{access,scope}=await reportingAccess(userId,siteId);
  const errors:string[]=[];let search:Array<{id:string;name:string}>=[],analytics:Array<{id:string;name:string}>=[];
  if(scope.split(' ').includes(SCOPES[0])) try {const data=await providerRequest('https://www.googleapis.com/webmasters/v3/sites',access);search=(data.siteEntry || []).filter((r:{siteUrl:string;permissionLevel:string})=>r.permissionLevel!=='siteUnverifiedUser' && searchPropertyMatches(r.siteUrl,site.url)).map((r:{siteUrl:string})=>({id:r.siteUrl,name:r.siteUrl}));} catch(e) {errors.push((e as Error).message);}
  if(scope.split(' ').includes(SCOPES[1])) try {const accounts=await listPages('https://analyticsadmin.googleapis.com/v1beta/accountSummaries',access,'accountSummaries');analytics=accounts.flatMap(a=>a.propertySummaries || []).map((p:Record<string,unknown>)=>({id:String(p.property).replace(/^properties\//,''),name:String(p.displayName || p.property)})).filter(p=>/^\d+$/.test(p.id));} catch(e) {errors.push((e as Error).message);}
  return {search,analytics,errors};
}
export async function configureReporting(userId:string,siteId:string,body:Record<string,unknown>) {
  const site=await ownedSite(userId,siteId);const props=await availableProperties(userId,siteId);
  const search=body.searchProperty,ga=body.gaProperty;
  if(search!==null && search!=='' && (typeof search!=='string' || !props.search.some(p=>p.id===search))) throw new MarketingError('Choose an accessible Search Console property for this website.');
  if(ga!==null && ga!=='' && (typeof ga!=='string' || !props.analytics.some(p=>p.id===ga))) throw new MarketingError('Choose an accessible GA4 property.');
  if(typeof body.dailySync!=='boolean') throw new MarketingError('Check daily reporting.');
  if(ga) {
    const {access}=await reportingAccess(userId,siteId);const streams=await listPages(`https://analyticsadmin.googleapis.com/v1beta/properties/${ga}/dataStreams`,access,'dataStreams');
    if(!streams.some(s=>typeof s.webStreamData?.defaultUri==='string' && sameWebsite(s.webStreamData.defaultUri,site.url))) throw new MarketingError('This GA4 property has no web stream for this website. Select the matching property.');
  }
  await query('UPDATE marketing_google_connections SET search_property=$3,ga_property=$4,daily_sync=$5,next_sync_at=CASE WHEN $5 THEN now() ELSE NULL END,error=NULL WHERE site_id=$1 AND user_id=$2',[siteId,userId,search || null,ga || null,body.dailySync && Boolean(search || ga)]);
}
export async function disconnectReporting(userId:string,siteId:string) {
  await ownedSite(userId,siteId);await query('DELETE FROM marketing_google_connections WHERE site_id=$1 AND user_id=$2',[siteId,userId]);await query('DELETE FROM marketing_oauth_states WHERE site_id=$1 AND user_id=$2',[siteId,userId]);
  await query("UPDATE marketing_jobs SET status='failed',error='Google reporting disconnected.',finished_at=now() WHERE site_id=$1 AND user_id=$2 AND kind='results' AND status='queued'",[siteId,userId]);
}
function reportingPeriod(previous=false) {const end=new Date();end.setUTCDate(end.getUTCDate()-3-(previous?28:0));const start=new Date(end);start.setUTCDate(start.getUTCDate()-27);return {periodStart:start.toISOString().slice(0,10),periodEnd:end.toISOString().slice(0,10)};}
const metric=(v:unknown,integer=false,signed=false)=>numberMetric(v,integer,signed) ?? 0;
export function parseSearchReport(total:Record<string,any>,pages:Record<string,any>,queries:Record<string,any>,period:ReturnType<typeof reportingPeriod>,property:string):ResultsSnapshot {
  const r=emptySnapshot('search-console','api',period);r.sourceLabel=property;r.timezone='America/Los_Angeles';
  for(const value of [total,pages,queries]) if(value.rows!==undefined && !Array.isArray(value.rows)) throw new MarketingError('Google returned an invalid Search Console report.',503);
  const row=total.rows?.[0];if(row && (row.clicks===undefined || row.impressions===undefined)) throw new MarketingError('Google returned incomplete Search Console totals.',503);
  r.clicks=metric(row?.clicks,true);r.impressions=metric(row?.impressions,true);if(r.clicks>r.impressions) throw new MarketingError('Search Console returned inconsistent counts.',503);r.ctr=r.impressions?r.clicks/r.impressions:null;r.position=r.impressions?numberMetric(row?.position):null;
  r.pages=(pages.rows || []).map((p:Record<string,any>)=>{const url=String(p.keys?.[0] || '');try {if(new URL(url).protocol!=='https:') throw new Error();} catch {throw new MarketingError('Google returned an invalid page URL.',503);}const clicks=metric(p.clicks,true),impressions=metric(p.impressions,true);if(clicks>impressions) throw new MarketingError('Google returned inconsistent page counts.',503);return {url,clicks,impressions,ctr:impressions?clicks/impressions:0,position:numberMetric(p.position)};});
  r.queries=(queries.rows || []).map((p:Record<string,any>)=>({query:String(p.keys?.[0] || ''),clicks:metric(p.clicks,true),impressions:metric(p.impressions,true)}));
  r.notes=['Finalized Web search data for this website; recent days are excluded.','Page and query tables contain up to 100 top rows. Query totals can omit anonymized searches; totals come from a separate aggregate request.','Search clicks are not sessions, search volume or guaranteed visits. Google AI Overview/AI Mode traffic is not separated here.'];return r;
}
export function parseAnalyticsReport(total:Record<string,any>,channels:Record<string,any>,ai:Record<string,any>,period:ReturnType<typeof reportingPeriod>,property:string):ResultsSnapshot {
  const r=emptySnapshot('ga4','api',period);r.sourceLabel=`GA4 property ${property}`;
  const read=(value:Record<string,any>,metricName:string,index=0)=>{const i=Array.isArray(value.metricHeaders)?value.metricHeaders.findIndex((h:{name:string})=>h.name===metricName):-1;if(i<0 || (value.rows!==undefined && !Array.isArray(value.rows))) throw new MarketingError('Google returned an invalid Analytics report.',503);if(value.rows?.[index] && value.rows[index].metricValues?.[i]?.value===undefined) throw new MarketingError('Google returned an incomplete Analytics metric.',503);return metric(value.rows?.[index]?.metricValues?.[i]?.value,metricName==='sessions' || metricName==='ecommercePurchases',metricName==='totalRevenue');};
  read(channels,'sessions');read(ai,'sessions');
  r.sessions=read(total,'sessions');r.keyEvents=read(total,'keyEvents');r.orders=read(total,'ecommercePurchases');r.revenue=read(total,'totalRevenue');r.currency=total.metadata?.currencyCode || null;r.timezone=total.metadata?.timeZone || 'Property timezone unavailable';
  r.channels=(channels.rows || []).map((p:Record<string,any>,i:number)=>({name:String(p.dimensionValues?.[0]?.value || '(not set)'),sessions:read(channels,'sessions',i)}));r.organicSessions=r.channels.filter(p=>p.name==='Organic Search').reduce((n,p)=>n+p.sessions,0);
  r.aiSources=(ai.rows || []).map((p:Record<string,any>,i:number)=>({name:String(p.dimensionValues?.[0]?.value || ''),sessions:read(ai,'sessions',i)})).filter((p:{name:string;sessions:number})=>isAIReferrer(p.name));r.aiSessions=r.aiSources.reduce((n,p)=>n+p.sessions,0);
  r.notes=['Analytics results are filtered to this website’s exact hostname and its www variant.','AI sessions count recognized referral domains only; unavailable referrers and direct visits cannot be attributed to AI.','Key events reflect the property’s configuration; they are not assumed to be leads. Revenue and purchases reflect recorded GA4 events, not an independently verified sales ledger.'];
  if(total.metadata?.subjectToThresholding || channels.metadata?.subjectToThresholding || ai.metadata?.subjectToThresholding) r.notes.push('Google applied data thresholding; some values may be withheld.');
  if(total.metadata?.samplingMetadatas?.length) r.notes.push('Google reports sampling for these results.');return r;
}
export async function fetchReportingSnapshots(userId:string,siteId:string):Promise<{snapshots:ResultsSnapshot[];errors:string[]}> {
  const site=await ownedSite(userId,siteId),connection=await one('SELECT search_property,ga_property FROM marketing_google_connections WHERE site_id=$1 AND user_id=$2',[siteId,userId]);
  if(!connection || (!connection.search_property && !connection.ga_property)) throw new MarketingError('Connect Google and choose reporting properties first.',409);
  const {access}=await reportingAccess(userId,siteId),period=reportingPeriod(),prior=reportingPeriod(true),snapshots:ResultsSnapshot[]=[],errors:string[]=[];
  const host=new URL(site.url).hostname.replace(/^www\./,'');const escaped=host.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(connection.search_property) try {
    const endpoint=`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(connection.search_property)}/searchAnalytics/query`;
    const search=(p:typeof period,dimensions:string[])=>providerRequest(endpoint,access,{startDate:p.periodStart,endDate:p.periodEnd,type:'web',dataState:'final',dimensions,rowLimit:100,dimensionFilterGroups:[{filters:[{dimension:'page',operator:'includingRegex',expression:`^https://(www\\.)?${escaped}/`}]}]});
    const values=await Promise.all([search(period,[]),search(period,['page']),search(period,['query']),search(prior,[])]);
    const r=parseSearchReport(values[0],values[1],values[2],period,connection.search_property),previous=parseSearchReport(values[3],{}, {},prior,connection.search_property);r.previous={clicks:previous.clicks!};snapshots.push(r);
  } catch(e) {errors.push((e as Error).message);}
  if(connection.ga_property) try {
    const endpoint=`https://analyticsdata.googleapis.com/v1beta/properties/${connection.ga_property}:runReport`;
    const report=(p:typeof period,dimensions:string[],metrics:string[],extra?:Record<string,unknown>)=>providerRequest(endpoint,access,{dateRanges:[{startDate:p.periodStart,endDate:p.periodEnd}],dimensions:dimensions.map(name=>({name})),metrics:metrics.map(name=>({name})),limit:100,dimensionFilter:{andGroup:{expressions:[{filter:{fieldName:'hostName',inListFilter:{values:[host,`www.${host}`],caseSensitive:false}}},...(extra?[extra]:[])]}}});
    const values=await Promise.all([report(period,[],['sessions','keyEvents','ecommercePurchases','totalRevenue']),report(period,['sessionDefaultChannelGroup'],['sessions']),report(period,['sessionSource'],['sessions'],{filter:{fieldName:'sessionSource',stringFilter:{matchType:'FULL_REGEXP',value:'(?i)(www\\.)?(chatgpt\\.com|chat\\.openai\\.com|perplexity\\.ai|gemini\\.google\\.com|copilot\\.microsoft\\.com|claude\\.ai)'}}}),report(prior,[],['sessions']),report(prior,['sessionDefaultChannelGroup'],['sessions'])]);
    const r=parseAnalyticsReport(values[0],values[1],values[2],period,connection.ga_property);
    if(!values[3].metricHeaders?.some((h:{name:string})=>h.name==='sessions') || !values[4].metricHeaders?.some((h:{name:string})=>h.name==='sessions')) throw new MarketingError('Google returned an incomplete comparison period.',503);
    const previousSessions=metric(values[3].rows?.[0]?.metricValues?.[0]?.value,true),previousOrganic=(values[4].rows || []).filter((p:Record<string,any>)=>p.dimensionValues?.[0]?.value==='Organic Search').reduce((n:number,p:Record<string,any>)=>n+metric(p.metricValues?.[0]?.value,true),0);r.previous={sessions:previousSessions,organicSessions:previousOrganic};snapshots.push(r);
  } catch(e) {errors.push((e as Error).message);}
  return {snapshots,errors};
}
