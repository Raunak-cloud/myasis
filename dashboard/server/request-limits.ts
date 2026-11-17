interface RequestIdentity {route:string;method:string;address:string;userId?:string|null}
export interface RequestLimit {category:string;key:string;limit:number;windowMs:number}

/** userId must come from the validated server session, never a request field. */
export function requestLimitPolicy({route,method,address,userId}:RequestIdentity):RequestLimit|null {
 if(!route.startsWith('/api/'))return null;
 const owner=userId?`user:${userId}`:`ip:${address}`;
 const policy=(category:string,limit:number,windowMs:number,identity=owner)=>({category,key:`${category}:${identity}`,limit,windowMs});
 // OAuth starts/callbacks remain protected by address, even across new sessions.
 if(route.startsWith('/api/auth/')&&!(route==='/api/auth/me'&&method==='GET'))return policy('sign-in',30,600_000,`ip:${address}`);
 if(route==='/api/billing/webhook')return policy('payment-webhook',120,60_000,`ip:${address}`);
 if(route.startsWith('/api/billing/')&&!(route==='/api/billing/status'&&method==='GET'))return policy('billing-actions',30,600_000);
 if(['/api/visit','/api/visit/pulse','/api/visit/leave'].includes(route))return policy('visits',120,60_000,`ip:${address}`);
 if(route==='/api/search-terms/generate')return policy('suggestions',10,3_600_000);
 if(route==='/api/assist/answer')return policy('answers',60,3_600_000);
 if(['/api/resumes','/api/knowledge'].includes(route)&&method==='POST')return policy('uploads',30,3_600_000);
 return method==='GET'||method==='HEAD'?policy('dashboard-reads',userId?1200:600,60_000):policy('api-actions',600,60_000);
}

/** Fixed windows, with an accurate remaining wait and bounded expired storage. */
export function createRequestLimiter(now:()=>number=Date.now) {
 const buckets=new Map<string,{count:number;resetAt:number}>();let sweepAt=0;
 return (policy:RequestLimit|null):{retryAfterSeconds:number;firstBlocked:boolean}|null=>{
  if(!policy)return null;
  const time=now();
  if(time>=sweepAt){for(const [key,value] of buckets)if(value.resetAt<=time)buckets.delete(key);sweepAt=time+300_000;}
  let bucket=buckets.get(policy.key);
  if(!bucket||bucket.resetAt<=time){bucket={count:0,resetAt:time+policy.windowMs};buckets.set(policy.key,bucket);}
  bucket.count++;
  return bucket.count>policy.limit?{retryAfterSeconds:Math.max(1,Math.ceil((bucket.resetAt-time)/1000)),firstBlocked:bucket.count===policy.limit+1}:null;
 };
}
