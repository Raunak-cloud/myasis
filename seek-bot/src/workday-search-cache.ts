import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
/** Only public search responses are shared. Job details are always fetched fresh. */
export function workdaySearchCache(directory:string,network:typeof fetch=fetch,now=Date.now):typeof fetch {
 return async(input,init)=>{
  const u=new URL(String(input));
  if(!/^[a-z0-9-]+\.wd\d{1,3}\.myworkdayjobs\.com$/.test(u.hostname)||!/^\/wday\/cxs\/[^/]+\/[^/]+\/jobs$/.test(u.pathname)||init?.method!=='POST')return network(input,init);
  const key=createHash('sha256').update(u.href+'\n'+String(init.body)).digest('hex'),file=resolve(directory,key+'.json');
  try{const v=JSON.parse(await readFile(file,'utf8'));if(v.at<=now()&&now()-v.at<30*60_000&&typeof v.body==='string')return new Response(v.body,{headers:{'Content-Type':'application/json'}});}catch{}
  const response=await network(input,init);if(!response.ok)return response;
  const body=await response.text();if(Buffer.byteLength(body)>8_000_000)throw Error('Public search response exceeded size limit.');
  try{const v=JSON.parse(body);if(Array.isArray(v.jobPostings)){await mkdir(directory,{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify({at:now(),body}),{mode:0o600});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}}}catch{/* Cache failure must not block a valid public response. */}
  return new Response(body,{status:response.status,headers:response.headers});
 };
}
