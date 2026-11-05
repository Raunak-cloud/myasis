import type pg from 'pg';
import { basename, resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { userResumeDir } from '../userdata.js';
import { fingerprint, recognisedSkills } from './extract.js';
import type { SearchProfile,FitEvidence } from './types.js';
import {RUN_SETTING_DEFAULTS} from '../settings.js';

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
const evidenceCache=new Map<string,{revision:string;evidence:FitEvidence}>();
export const professionalEvidence=(text:string):string=>text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[email omitted]').replace(/https?:\/\/\S+/gi,'[link omitted]').replace(/\+\d(?:[ ()-]*\d){7,14}\b|\b0[2-478](?:[ ()-]*\d){8}\b/g,'[contact omitted]').slice(0,40_000);
export async function paidProfiles(db:pg.Pool,readResume=resumeText,cached:SearchProfile[]=[]):Promise<{profiles:SearchProfile[];evidence:Map<string,FitEvidence>;seeds:string[];warnings:string[]}> {
  const users=(await db.query<{id:string}>(PAID_ACCOUNTS_SQL)).rows;const profiles:SearchProfile[]=[],warnings:string[]=[];
  const evidence=new Map<string,FitEvidence>();
  for(const id of evidenceCache.keys())if(!users.some(u=>u.id===id))evidenceCache.delete(id);
  for(const {id} of users) {
    const settings={...RUN_SETTING_DEFAULTS,...Object.fromEntries((await db.query<{key:string;value:string}>(`SELECT key,value FROM settings WHERE user_id=$1 AND key IN ('KEYWORDS','WORK_ARRANGEMENTS','ONSITE_CITY','EXCLUDED_COMPANIES','SMARTRECRUITERS_COMPANIES','GREENHOUSE_BOARDS','PAGEUP_SITES','WORKDAY_SITES','MIN_SCORE','MIN_SALARY','MIN_HOURLY_RATE','MAX_AGE_DAYS','JOB_TYPES','AI_INSTRUCTIONS_B64','SEARCH_RADIUS_KM')`,[id])).rows.map(r=>[r.key,r.value]))};
    const profile=(await db.query<{skills:string;headline:string}>('SELECT skills,headline FROM profiles WHERE user_id=$1',[id])).rows[0];
    const resumes=(await db.query<{id:string;file_name:string;uploaded_at:Date}>('SELECT id::text,file_name,uploaded_at FROM resumes WHERE user_id=$1 ORDER BY is_default DESC,uploaded_at DESC LIMIT 3',[id])).rows;
    const fileStates=await Promise.all(resumes.map(async r=>{try{const s=await stat(resolve(userResumeDir(id),basename(r.file_name)));return {id:r.id,mtime:s.mtimeMs,size:s.size};}catch{return {id:r.id,missing:true};}}));
    const sourceRevision=fingerprint({policy:2,settings,profile,resumes,fileStates});
    const previous=cached.find(p=>p.userId===id&&p.sourceRevision===sourceRevision);
    const previousEvidence=evidenceCache.get(id);
    if(previous&&previousEvidence?.revision===sourceRevision){profiles.push(previous);evidence.set(id,previousEvidence.evidence);continue;}
    const texts:string[]=[];
    for(const r of resumes) { try {texts.push(await readResume(id,r.file_name));} catch {warnings.push(`Account ${id}: resume ${r.id} could not be extracted; saved keywords/profile skills remain available.`);} }
    const text=texts.join('\n').slice(0,120_000);let keywords=safeKeywords(settings.KEYWORDS??'');
    if(!keywords.length)keywords=roles.filter(role=>text.toLowerCase().includes(role.toLowerCase())||(profile?.headline??'').toLowerCase().includes(role.toLowerCase())).slice(0,5);
    const skills=recognisedSkills(`${profile?.skills??''}\n${text}`);
    const targeting={keywords,skills,location:(settings.ONSITE_CITY??'').trim().slice(0,150),arrangements:(settings.WORK_ARRANGEMENTS??'').split(',').filter(v=>['onsite','hybrid','remote'].includes(v)),excludedCompanies:(settings.EXCLUDED_COMPANIES??'').split(/[,;\n]/).map(v=>v.trim()).filter(Boolean),sources:Object.fromEntries(Object.entries(settings).filter(([k])=>/^(SMARTRECRUITERS_COMPANIES|GREENHOUSE_BOARDS|PAGEUP_SITES|WORKDAY_SITES)$/.test(k)))};
    const number=(key:string)=>Number.isFinite(Number(settings[key]))?Math.max(0,Number(settings[key])):Number(RUN_SETTING_DEFAULTS[key]??0);
    const criteria={minScore:Math.min(100,number('MIN_SCORE')),minSalary:number('MIN_SALARY'),minHourlyRate:number('MIN_HOURLY_RATE'),maxAgeDays:number('MAX_AGE_DAYS'),radiusKm:number('SEARCH_RADIUS_KM'),jobTypes:settings.JOB_TYPES.split(',').filter(Boolean)};
    profiles.push({userId:id,sourceRevision,fingerprint:fingerprint({targeting,criteria,resume:fingerprint(text),instructions:settings.AI_INSTRUCTIONS_B64}),...targeting,criteria});
    const facts={resume:professionalEvidence([profile?.headline,profile?.skills,text].filter(Boolean).join('\n')),instructions:professionalEvidence(Buffer.from(settings.AI_INSTRUCTIONS_B64??'','base64').toString('utf8'))};
    evidence.set(id,facts);if(evidenceCache.size>=100)evidenceCache.delete(evidenceCache.keys().next().value!);evidenceCache.set(id,{revision:sourceRevision,evidence:facts});
  }
  const ids=profiles.map(p=>p.userId);
  const seeds=ids.length?(await db.query<{url:string}>(`SELECT DISTINCT url FROM applications WHERE user_id=ANY($1::bigint[]) AND external AND applied_at>now()-interval '90 days' AND url<>'' LIMIT 200`,[ids])).rows.map(r=>r.url):[];
  return {profiles,evidence,seeds,warnings};
}
