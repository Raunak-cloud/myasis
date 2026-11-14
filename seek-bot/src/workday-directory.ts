import {careerTarget} from './employer-source-config.js';
/** Canonical public Workday board root, never a login, application or private URL. */
export function workdaySite(raw:string):string|null {
 try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
 const parts=u.pathname.split('/').filter(Boolean);if(!parts.length)return null;
 const hasLocale=/^[a-z]{2}-[A-Z]{2}$/.test(parts[0]);
 const site=parts[hasLocale?1:0];if(!site||/^(login|signin|apply|candidatehome)$/i.test(site))return null;
 // Publisher's current public career bootstrap identifies wd103; wd3 returns 422.
 // Resolve the old address at read time without rewriting anyone's preferences.
 if(u.hostname==='accenture.wd3.myworkdayjobs.com'&&site==='AccentureCareers')u.hostname='accenture.wd103.myworkdayjobs.com';
 const root=`${u.origin}/${hasLocale?parts[0]:'en-US'}/${site}`;
 return careerTarget('workday',root).url.href;
 }catch{return null;}
}
export function workdayDirectoryTargets(values:unknown):string[]{
 if(!Array.isArray(values))return [];
 const roots=new Map<string,string>();
 for(const value of values){if(typeof value!=='string')continue;const parts=value.split('|');if(parts.length>2)continue;const root=workdaySite(parts.at(-1)!);if(root){const u=new URL(root),identity=u.hostname+'/'+u.pathname.split('/')[2];if(!roots.has(identity))roots.set(identity,parts.length===2?`${parts[0].slice(0,100)}|${root}`:root);}}
 return [...roots.values()];
}
