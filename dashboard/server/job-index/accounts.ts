import type pg from 'pg';
import { basename, resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { userResumeDir } from '../userdata.js';
import { fingerprint, recognisedSkills } from './extract.js';
import type { SearchProfile } from './types.js';

export const PAID_ACCOUNTS_SQL=`SELECT DISTINCT u.id::text FROM users u
 JOIN application_credit_grants g ON g.user_id=u.id
 JOIN billing_purchases p ON p.id=g.purchase_id AND p.user_id=u.id
 WHERE u.blocked_at IS NULL AND p.plan_key IN ('essential-pass','job-search-pass','intensive-pass')
 AND (g.expires_at IS NULL OR g.expires_at>now()) ORDER BY u.id::text`;
const roles=['Software engineer','Software developer','Web developer','Data analyst','Data engineer','Data scientist','Business analyst','Project manager','Product manager','Accountant','Bookkeeper','Payroll officer','Administrative assistant','Customer service','Retail assistant','Warehouse assistant','Support worker','Registered nurse','Teacher','Graduate engineer','Mechanical engineer','Civil engineer','Electrical engineer','Marketing coordinator'];
export function safeKeywords(raw:string):string[] {
  return [...new Set(raw.split(/[,;\n]/).map(v=>v.trim()).filter(v=>v.length>=3&&v.length<=70&&/^[\p{L}+#.\s/-]+$/u.test(v)))].slice(0,8);
}
async function resumeText(userId:string,fileName:string):Promise<string> {
  if(basename(fileName)!==fileName)return '';
  const root=await realpath(userResumeDir(userId)),path=await realpath(resolve(root,fileName));
  if(!path.startsWith(root+sep)||(await stat(path)).size>8*1024*1024)throw Error('Resume source is outside the owned file boundary or exceeds its size limit.');
  const mod=await import(/* @vite-ignore */ new URL('../../../seek-bot/dist/knowledge.js',import.meta.url).href) as {extractText:(p:string)=>Promise<string>};
  return (await mod.extractText(path)).slice(0,60_000);
}
/** Only safe skill/role terms leave this function; full text is kept in memory. */
export async function paidProfiles(db:pg.Pool,readResume=resumeText,cached:SearchProfile[]=[]):Promise<{profiles:SearchProfile[];seeds:string[];warnings:string[]}> {
  const users=(await db.query<{id:string}>(PAID_ACCOUNTS_SQL)).rows;const profiles:SearchProfile[]=[],warnings:string[]=[];
  for(const {id} of users) {
    const settings=Object.fromEntries((await db.query<{key:string;value:string}>(`SELECT key,value FROM settings WHERE user_id=$1 AND key IN ('KEYWORDS','WORK_ARRANGEMENTS','ONSITE_CITY','EXCLUDED_COMPANIES','SMARTRECRUITERS_COMPANIES','GREENHOUSE_BOARDS','PAGEUP_SITES','WORKDAY_SITES')`,[id])).rows.map(r=>[r.key,r.value]));
    const profile=(await db.query<{skills:string;headline:string}>('SELECT skills,headline FROM profiles WHERE user_id=$1',[id])).rows[0];
    const resumes=(await db.query<{id:string;file_name:string;uploaded_at:Date}>('SELECT id::text,file_name,uploaded_at FROM resumes WHERE user_id=$1 ORDER BY is_default DESC,uploaded_at DESC LIMIT 3',[id])).rows;
    const fileStates=await Promise.all(resumes.map(async r=>{try{const s=await stat(resolve(userResumeDir(id),basename(r.file_name)));return {id:r.id,mtime:s.mtimeMs,size:s.size};}catch{return {id:r.id,missing:true};}}));
    const sourceRevision=fingerprint({settings,profile,resumes,fileStates});
    const previous=cached.find(p=>p.userId===id&&p.sourceRevision===sourceRevision);
    if(previous){profiles.push(previous);continue;}
    const texts:string[]=[];
    for(const r of resumes) { try {texts.push(await readResume(id,r.file_name));} catch {warnings.push(`Account ${id}: resume ${r.id} could not be extracted; saved keywords/profile skills remain available.`);} }
    const text=texts.join('\n').slice(0,120_000);let keywords=safeKeywords(settings.KEYWORDS??'');
    if(!keywords.length)keywords=roles.filter(role=>text.toLowerCase().includes(role.toLowerCase())||(profile?.headline??'').toLowerCase().includes(role.toLowerCase())).slice(0,5);
    const skills=recognisedSkills(`${profile?.skills??''}\n${text}`);
    const targeting={keywords,skills,location:(settings.ONSITE_CITY??'').trim().slice(0,150),arrangements:(settings.WORK_ARRANGEMENTS??'').split(',').filter(v=>['onsite','hybrid','remote'].includes(v)),excludedCompanies:(settings.EXCLUDED_COMPANIES??'').split(/[,;\n]/).map(v=>v.trim()).filter(Boolean),sources:Object.fromEntries(Object.entries(settings).filter(([k])=>/^(SMARTRECRUITERS_COMPANIES|GREENHOUSE_BOARDS|PAGEUP_SITES|WORKDAY_SITES)$/.test(k)))};
    profiles.push({userId:id,sourceRevision,fingerprint:fingerprint({targeting,resume:fingerprint(text)}),...targeting});
  }
  const ids=profiles.map(p=>p.userId);
  const seeds=ids.length?(await db.query<{url:string}>(`SELECT DISTINCT url FROM applications WHERE user_id=ANY($1::bigint[]) AND external AND applied_at>now()-interval '90 days' AND url<>'' LIMIT 200`,[ids])).rows.map(r=>r.url):[];
  return {profiles,seeds,warnings};
}
