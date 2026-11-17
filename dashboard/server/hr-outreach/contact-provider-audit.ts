/** Read-only comparison helpers. These results are not production recipients:
 * provider coverage and verification labels do not establish hiring suitability. */
export interface AuditCompany {company:string;domain?:string;title?:string;location?:string;url?:string;description?:string;descriptionObservedAt?:string}
export interface AuditContact {
 email:string;name?:string;title?:string;department?:string;organization?:string;
 location?:string;verification?:string;verifiedAt?:string;provenance?:string;sources:string[];
}
export interface ContactProviderAudit {
 provider:'hunter'|'apollo';company:string;outcome:'contacts_returned'|'no_results'|'people_without_email'|'not_configured'|'domain_required'|'error';
 contacts:AuditContact[];calls:number;enrichments:number;elapsedMs:number;peopleFound?:number;
 error?:{code:string;status?:number};reportedCredits:number|null;
}
interface AuditOptions {key?:string;network?:typeof fetch;signal?:AbortSignal;maxReveals?:number;hunterDepartment?:'hr'|'all'}
const str=(value:unknown):string|undefined=>typeof value==='string'&&value.trim()?value.trim():undefined;
const address=(value:unknown)=>{const s=str(value)?.toLowerCase();return s&&/^[a-z0-9.!#$%&'+/=^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(s)?s:undefined;};
const source=(value:unknown)=>{try{const u=new URL(String(value));return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:undefined;}catch{return undefined;}};
function cleanDomain(value:string):string {
 const u=new URL(value.includes('://')?value:`https://${value}`);
 if(!u.hostname.includes('.')||u.username||u.password||u.port||/^[\d.]+$|:/.test(u.hostname))throw Error('Invalid company domain.');
 return u.hostname.toLowerCase().replace(/^www\./,'');
}
const httpCode=(status:number)=>status===401?'authentication_failed':status===403?'api_access_denied':status===402?'credits_or_billing':status===429?'rate_limited':'provider_http_error';
class AuditResponseError extends Error {readonly status:number;constructor(status:number){super('Contact provider request failed.');this.status=status;}}

export async function auditContactProvider(provider:'hunter'|'apollo',input:AuditCompany,options:AuditOptions):Promise<ContactProviderAudit>{
 const start=Date.now(),result:ContactProviderAudit={provider,company:input.company,outcome:'not_configured',contacts:[],calls:0,enrichments:0,elapsedMs:0,reportedCredits:null};
 if(!options.key?.trim())return result;
 const signal=AbortSignal.any([AbortSignal.timeout(90_000),...(options.signal?[options.signal]:[])]);
 const request=async(url:URL,body?:Record<string,unknown>)=>{
  signal.throwIfAborted();result.calls++;
  const response=await(options.network??fetch)(url,{method:body?'POST':'GET',redirect:'error',signal,
   headers:{Accept:'application/json','X-API-KEY':options.key!.trim(),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const credit=response.headers.get('X-Credits-Used');if(credit!==null&&Number.isFinite(Number(credit)))result.reportedCredits=(result.reportedCredits??0)+Number(credit);
  if(!response.ok)throw new AuditResponseError(response.status);
  return await response.json();
 };
 try{
  const domain=input.domain?cleanDomain(input.domain):undefined;
  if(provider==='hunter'){
   const url=new URL('https://api.hunter.io/v2/domain-search');url.searchParams.set(domain?'domain':'company',domain??input.company);
   if(options.hunterDepartment!=='all')url.searchParams.set('department','hr');url.searchParams.set('limit','10');
   const body=await request(url);
   if(!Array.isArray(body?.data?.emails))throw Error('Invalid provider response.');
   result.peopleFound=typeof body.meta?.results==='number'?body.meta.results:body.data.emails.length;
   result.contacts=body.data.emails.flatMap((row:any)=>{const email=address(row?.value);return email?[{
    email,name:str([row.first_name,row.last_name].filter(Boolean).join(' ')),title:str(row.position),department:str(row.department),organization:str(body.data.organization),
    verification:str(row.verification?.status),verifiedAt:str(row.verification?.date),provenance:str(row.provenance),
    sources:(Array.isArray(row.sources)?row.sources:[]).flatMap((s:any)=>{const url=source(s?.uri);return url?[url]:[];})
   }]:[];});
   result.outcome=result.contacts.length?'contacts_returned':result.peopleFound?'people_without_email':'no_results';
  }else{
   if(!domain){result.outcome='domain_required';return result;}
   const url=new URL('https://api.apollo.io/api/v1/mixed_people/api_search');
   url.searchParams.append('q_organization_domains_list[]',domain);
   for(const title of ['talent acquisition','recruiter','recruitment manager','human resources','HR manager'])url.searchParams.append('person_titles[]',title);
   url.searchParams.set('include_similar_titles','true');url.searchParams.set('per_page','5');url.searchParams.set('page','1');
   const body=await request(url,{});
   if(!Array.isArray(body?.people))throw Error('Invalid provider response.');
   result.peopleFound=typeof body.total_entries==='number'?body.total_entries:body.people.length;
   const limit=Math.max(0,Math.min(2,Math.trunc(options.maxReveals??1)));
   // Only the company's work-email match is requested. No personal addresses,
   // phones, waterfall vendors, sequences, CRM writes or mail sends.
   const people=body.people.filter((p:any)=>p?.has_email!==false&&str(p?.id??p?.person_id)).slice(0,limit);
   for(const candidate of people){
    const enrichedUrl=new URL('https://api.apollo.io/api/v1/people/match');
    enrichedUrl.searchParams.set('id',candidate.id??candidate.person_id);
    for(const name of ['reveal_personal_emails','reveal_phone_number','run_waterfall_email','run_waterfall_phone'])enrichedUrl.searchParams.set(name,'false');
    result.enrichments++;
    const data=await request(enrichedUrl,{}),person=data?.person;
    const email=address(person?.email);if(!email)continue;
    const linkedin=source(person.linkedin_url);
    result.contacts.push({email,name:str(person.name),title:str(person.title??candidate.title),organization:str(person.organization?.name??candidate.organization?.name),
     location:str([person.city,person.state,person.country].filter(Boolean).join(', ')),verification:str(person.email_status),sources:linkedin?[linkedin]:[]});
   }
   result.outcome=result.contacts.length?'contacts_returned':result.peopleFound?'people_without_email':'no_results';
  }
 }catch(error){
  result.outcome='error';result.error=error instanceof AuditResponseError?{code:httpCode(error.status),status:error.status}:{code:signal.aborted?'cancelled_or_timeout':'request_or_response_failed'};
 }finally{result.elapsedMs=Date.now()-start;}
 return result;
}
