/** Share only identical GETs. Writes always use their own fetch and are never replayed. */
export function createDashboardRequests(fetcher:typeof fetch=(...args)=>fetch(...args),now:()=>number=Date.now) {
 let account:string|null|undefined;
 const requests=new Map<string,{controller:AbortController;promise:Promise<Response>;retryUntil:number}>();
 function invalidate(path?:string) {
  for(const [key,entry] of requests)if(!path||key===path||key.startsWith(path+'?')){entry.controller.abort();requests.delete(key);}
 }
 function setAccount(next:string|null) {if(account===next)return false;account=next;invalidate();return true;}
 function get(path:string):Promise<Response> {
  const previous=requests.get(path);
  if(previous&&(!previous.retryUntil||previous.retryUntil>now()))return previous.promise.then(response=>response.clone());
  if(previous)requests.delete(path);
  const controller=new AbortController();
  const entry={controller,retryUntil:0,promise:null as unknown as Promise<Response>};
  entry.promise=Promise.resolve().then(()=>fetcher(path,{signal:controller.signal})).then(response=>{
   if(controller.signal.aborted)throw new DOMException('Dashboard account or data changed.','AbortError');
   if(response.status===429){
    const header=response.headers.get('Retry-After');
    const seconds=header!==null&&header.trim()!==''?Number(header):NaN;
    const until=Number.isFinite(seconds)?now()+Math.max(0,seconds)*1000:Date.parse(header??'');
    entry.retryUntil=Number.isFinite(until)&&until>now()?until:now()+1000;
   }
   return response;
  }).finally(()=>{if(requests.get(path)===entry&&!entry.retryUntil)requests.delete(path);});
  requests.set(path,entry);
  return entry.promise.then(response=>response.clone());
 }
 return {get,setAccount,invalidate};
}

const shared=createDashboardRequests();
export const dashboardGet=shared.get;
export const DASHBOARD_ACCOUNT_CHANGED='dashboard-account-changed';
export function setDashboardAccount(id:string|null) {
 if(shared.setAccount(id)&&typeof window!=='undefined')window.dispatchEvent(new Event(DASHBOARD_ACCOUNT_CHANGED));
}
if(typeof window!=='undefined'){
 // Invalidate before component listeners read changed data. One event produces one fresh GET.
 const paths:Record<string,string[]>={
  'billing-changed':['/api/billing/status'],
  'boards-changed':['/api/signin/session','/api/billing/status','/api/entitlements','/api/setup/status'],
  'entitlements-changed':['/api/billing/status','/api/entitlements'],
  'entitlements-refresh':['/api/entitlements'],
  'setup-status-changed':['/api/setup/status'],
  'signin-session-changed':['/api/signin/session'],
 };
 for(const [event,urls] of Object.entries(paths))window.addEventListener(event,()=>urls.forEach(shared.invalidate),{capture:true});
}
