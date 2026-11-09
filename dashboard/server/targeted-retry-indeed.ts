import {query} from './db/index.js';
import {jobBoardForUrl} from '../../seek-bot/src/job-board-url.js';
import type {TargetedSeekJob} from './targeted-retry-jobs.js';

/** Resolve an exact Indeed posting from this owner's recorded work. This is
 * metadata for the normal matching/applying path, never a submission receipt. */
export async function targetedIndeedRetryJobs(userId:string,ids:string[],read:typeof query=query):Promise<TargetedSeekJob[]|null>{
 if(!/^\d{1,19}$/.test(userId)||!ids.length||ids.some(id=>!/^[a-f0-9]{16}$/i.test(id)))return null;
 const rows=await read<TargetedSeekJob&{url:string}>(`SELECT DISTINCT ON (job_id) job_id,title,company,url FROM run_events
  WHERE user_id=$1 AND job_id=ANY($2::text[]) AND title<>'' AND company<>'' AND url IS NOT NULL
  ORDER BY job_id,ts DESC`,[userId,ids]);
 const found=new Map<string,TargetedSeekJob>();
 for(const row of rows){
  if(!ids.includes(row.job_id)||!row.title?.trim()||!row.company?.trim())return null;
  try{
   const url=new URL(row.url);
   if(url.protocol!=='https:'||url.username||url.password||url.port||jobBoardForUrl(url.href)!=='indeed'
    ||(url.searchParams.get('jk')??url.searchParams.get('vjk'))?.toLowerCase()!==row.job_id.toLowerCase())return null;
  }catch{return null;}
  found.set(row.job_id,{job_id:row.job_id,title:row.title,company:row.company});
 }
 return ids.every(id=>found.has(id))?ids.map(id=>found.get(id)!):null;
}
