import type { GrowthRun, GrowthStep, MarketingSite, MarketingTopic, OrganicStrategy, ResultsSnapshot } from '../../src/marketingTypes.js';

export const growthSteps = [
  ['results','Read measured results'], ['health','Check website health'], ['research','Refresh market research'],
  ['visibility','Check AI visibility'], ['strategy','Choose the next priorities'], ['content','Prepare useful content'],
] as const;
export const newGrowthRun = ():GrowthRun => ({startedAt:new Date().toISOString(),completedAt:null,steps:growthSteps.map(([key,title])=>({key,title,status:'pending',summary:'Waiting to start.',finishedAt:null}))});
type Outcome={status:'done'|'attention'|'skipped';summary:string};

/** Each completed step is checkpointed. Provider failures leave evidence gaps and do not discard other work. */
export async function runGrowthSteps(report:GrowthRun,hooks:{
  allowed:()=>Promise<boolean>; save:(report:GrowthRun)=>Promise<void>;
  perform:(key:GrowthStep['key'])=>Promise<Outcome>; error:(error:unknown,key:GrowthStep['key'])=>string;
}):Promise<GrowthRun> {
  if(report.completedAt) return report;
  for(const step of report.steps) {
    if(['done','attention','skipped'].includes(step.status)) continue;
    if(!await hooks.allowed()) {
      step.status='skipped';step.summary='Stopped because automation was paused or admin access was removed.';
    } else {
      step.status='running';await hooks.save(report);
      try {const outcome=await hooks.perform(step.key);step.status=outcome.status;step.summary=outcome.summary.slice(0,2400);}
      catch(e) {step.status='attention';step.summary=hooks.error(e,step.key).slice(0,1200);}
    }
    step.finishedAt=new Date().toISOString();await hooks.save(report);
  }
  report.completedAt=new Date().toISOString();await hooks.save(report);return report;
}

export function nextGrowthTopic(topics:MarketingTopic[],strategy:OrganicStrategy,goal:MarketingSite['growthGoal']):MarketingTopic|null {
  const eligible=new Set(strategy.actions.filter(a=>a.kind==='new' && a.status==='open').map(a=>a.topicId));
  const rank=(t:MarketingTopic)=>goal==='sales'?(t.intent==='buy'?0:t.intent==='compare'?1:2):goal==='leads'?(t.intent==='compare'?0:t.intent==='buy'?1:2):(t.priority==='high'?0:1);
  return topics.filter(t=>t.status==='planned' && eligible.has(t.id)).sort((a,b)=>rank(a)-rank(b)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0] || null;
}

export function automaticPublicationHold(site:MarketingSite,now=Date.now()):string|null {
  if(!site.profileConfirmed) return 'Confirm the current website profile before publication.';
  if(!site.health || !Number.isFinite(Date.parse(site.health.checkedAt)) || now-Date.parse(site.health.checkedAt)>7*86400_000) return 'A recent website health audit is needed before automatic publication.';
  if(!site.health.pages.some(p=>!p.error && p.status!==null && p.status>=200 && p.status<400)) return 'No public pages could be read; review website access before publishing.';
  if(site.health.findings.some(f=>f.severity==='urgent')) return 'Review urgent website health findings before automatic publication. A draft can still be prepared.';
  return null;
}

export function resultsBrief(snapshots:ResultsSnapshot[]):string {
  const bySource=['search-console','ga4'].flatMap(source=>{
    const report=snapshots.find(s=>s.source===source && s.method==='api');if(!report) return [];
    const value=source==='search-console'?report.clicks:report.organicSessions;
    const previous=source==='search-console'?report.previous?.clicks:report.previous?.organicSessions;
    const metric=source==='search-console'?'search clicks':'organic search sessions';
    return [`${report.sourceLabel}, ${report.periodStart} to ${report.periodEnd}: ${value===null?'unmeasured':value} ${metric}${value!==null && previous!==undefined?`; ${value-previous>=0?'+':''}${value-previous} versus the previous equal-length period`:''}.`];
  });
  return bySource.length?bySource.join(' ')+' Changes are observations, not proof that the agent caused them.':'No connected API measurements are available. Imported and recorded results remain visible under Results; growth is unmeasured until a comparable period is available.';
}
