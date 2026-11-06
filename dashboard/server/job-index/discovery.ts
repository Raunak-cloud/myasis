import {safeKeywords} from './accounts.js';
import type {SearchProfile} from './types.js';
import {professionalRoleTerms} from './search-terms.js';

/** Bounded, rotating queries; only derived role/skill terms leave the service. */
export function discoveryQueries(profiles:SearchProfile[],day=new Date().toISOString().slice(0,10)):string[] {
  const sites=['job-boards.greenhouse.io','jobs.lever.co','jobs.ashbyhq.com','myworkdayjobs.com','careers.pageuppeople.com','jobs.smartrecruiters.com'];
  const turn=Math.floor(Date.parse(day)/86400_000);
  const byOwner=profiles.map(p=>{
    const roles=professionalRoleTerms((p.searchRoles??p.keywords).join(',')),skills=safeKeywords(p.skills.join(','));
    const offset=roles.length?turn%roles.length:0;
    const terms=roles.length?[...roles.slice(offset),...roles.slice(0,offset)]:skills.slice(0,3);
    return terms.flatMap((role,i)=>{
      const city=safeKeywords(p.location).slice(0,2).map(v=>`"${v}"`).join(' ')||'"Australia"';
      const base=`"${role}" ${city}`;
      const skill=skills.length?` "${skills[(turn+i)%skills.length]}"`:'';
      const local=[`${base} careers jobs`,`${base}${skill} careers -site:seek.com.au -site:indeed.com`,`${base} site:${sites[(turn+i)%sites.length]}`];
      return p.arrangements.includes('remote')&&!/stock[\s-]*tak|(?:dog|pet)[\s-]*walk/i.test(role)?[...local,`"${role}" remote "Australia" careers`,`"${role}" remote "Australia" site:${sites[(turn+i)%sites.length]}`]:local;
    });
  });
  const queries=new Set<string>();
  // Interleave owners rather than letting the first customer's terms consume
  // the provider's existing global daily allowance.
  for(let i=0;i<24;i++)for(const owner of byOwner)if(owner[i])queries.add(owner[i]);
  return [...queries];
}
