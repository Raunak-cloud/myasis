import {careerTarget} from './employer-source-config.js';
/** Canonical public Workday board root, never a login, application or private URL. */
export function workdaySite(raw:string):string|null {
 try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
 const parts=u.pathname.split('/').filter(Boolean);if(parts.length<2)return null;
 if(/^(login|signin|apply|candidatehome)$/i.test(parts[1]))return null;
 const root=`${u.origin}/${parts.slice(0,2).join('/')}`;
 return careerTarget('workday',root).url.href;
 }catch{return null;}
}
export function workdayDirectoryTargets(values:unknown):string[]{
 if(!Array.isArray(values))return [];
 const roots=new Map<string,string>();
 for(const value of values){if(typeof value!=='string')continue;const parts=value.split('|');if(parts.length>2)continue;const root=workdaySite(parts.at(-1)!);if(root){const u=new URL(root),identity=u.hostname+'/'+u.pathname.split('/')[2];if(!roots.has(identity))roots.set(identity,parts.length===2?`${parts[0].slice(0,100)}|${root}`:root);}}
 return [...roots.values()];
}
