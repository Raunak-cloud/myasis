import {assertExternalNavigationUrl} from './external-url.js';

const trackingHost=(url:string)=>['adzuna.com.au','www.adzuna.com.au'].includes(new URL(url).hostname);
type Options={fetch?:typeof fetch;validate?:(url:string)=>Promise<string>};

/** Resolve the public Adzuna click-through, retaining attribution, before the
 * existing browser/board adapter opens the actual vacancy. No candidate data
 * or browser cookies are sent by this lookup. */
export async function resolveAdzunaRedirect(source:string,options:Options={}):Promise<string>{
 const validate=options.validate??(url=>assertExternalNavigationUrl(url,undefined,true));
 let url=await validate(source);
 if(!trackingHost(url))throw Error('Invalid Adzuna tracking address.');
 const seen=new Set<string>();
 while(trackingHost(url)){
  if(seen.has(url)||seen.size>=10)throw Error('Adzuna returned a repeated tracking redirect.');
  seen.add(url);
  let response:Response;
  try{response=await(options.fetch??fetch)(url,{redirect:'manual',credentials:'omit',headers:{Accept:'text/html'},signal:AbortSignal.timeout(15000)});}
  catch{throw Error('The Adzuna vacancy link could not be reached.');}
  const location=response.headers.get('location'),status=response.status;
  await response.body?.cancel();
  if(status>=300&&status<400){
   if(!location)throw Error('Adzuna returned a redirect without a vacancy address.');
   try{url=await validate(new URL(location,url).href);}catch{throw Error('Adzuna returned an unavailable vacancy address.');}
  }else{
   if(!response.ok)throw Error(`The Adzuna vacancy link returned HTTP ${status}.`);
   // Some advertisements render on Adzuna before their normal Apply control.
   return url;
  }
 }
 return url;
}
