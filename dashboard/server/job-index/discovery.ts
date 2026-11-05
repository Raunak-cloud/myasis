import {safeKeywords} from './accounts.js';
import type {SearchProfile} from './types.js';

/** Bounded, rotating queries; only derived role/skill terms leave the service. */
export function discoveryQueries(profiles:SearchProfile[],day=new Date().toISOString().slice(0,10)):string[] {
  const sites=['job-boards.greenhouse.io','jobs.lever.co','jobs.ashbyhq.com','myworkdayjobs.com','careers.pageuppeople.com','jobs.smartrecruiters.com'];
  const turn=Math.floor(Date.parse(day)/86400_000);
  const byOwner=profiles.map(p=>{
    const roles=safeKeywords(p.keywords.join(',')),skills=safeKeywords(p.skills.join(','));
    const terms=roles.length?roles:skills.slice(0,3);
    return terms.flatMap((role,i)=>{
      const base=`"${role}"`;
      const skill=skills.length?` "${skills[(turn+i)%skills.length]}"`:'';
      return [`${base} careers jobs "Australia"`,`${base}${skill} careers "Australia" -site:seek.com.au -site:indeed.com`,`${base} "Australia" site:${sites[(turn+i)%sites.length]}`];
    });
  });
  const queries=new Set<string>();
  // Interleave owners rather than letting the first customer's terms consume
  // the provider's existing global daily allowance.
  for(let i=0;i<24;i++)for(const owner of byOwner)if(owner[i])queries.add(owner[i]);
  return [...queries];
}
