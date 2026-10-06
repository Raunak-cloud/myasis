import { useEffect, useState } from 'react';
import type { MarketingSite, MarketingWorkspace } from '../marketingTypes';
import { marketingApi as api } from './marketingApi';
import type { GrowthView } from './MarketingGrowth';

const date=(s:string)=>new Date(s).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
export function MarketingAutopilot({data,path,busy,running,act,onView}:{
  data:MarketingWorkspace;path:string;busy:boolean;running:boolean;
  act:(work:()=>Promise<unknown>,message?:string)=>Promise<boolean>;onView:(view:GrowthView)=>void;
}) {
  const site=data.site;
  const [enabled,setEnabled]=useState(site.scheduleEnabled),[mode,setMode]=useState(site.publishMode);
  const [goal,setGoal]=useState<NonNullable<MarketingSite['growthGoal']>>(site.growthGoal || 'traffic');
  const [provider,setProvider]=useState<NonNullable<MarketingSite['growthAIProvider']>>(site.growthAIProvider || 'off');
  const [day,setDay]=useState(site.scheduleDay),[time,setTime]=useState(site.scheduleTime),[zone,setZone]=useState(site.timezone);
  useEffect(()=>{setEnabled(site.scheduleEnabled);setMode(site.publishMode);setGoal(site.growthGoal || 'traffic');setProvider(site.growthAIProvider || 'off');setDay(site.scheduleDay);setTime(site.scheduleTime);setZone(site.timezone);},[site.scheduleEnabled,site.publishMode,site.growthGoal,site.growthAIProvider,site.scheduleDay,site.scheduleTime,site.timezone]);
  const latest=data.jobs.find(j=>j.growthRun),report=latest?.growthRun;
  const connected=data.growth?.connection.connected && Boolean(data.growth.connection.searchProperty || data.growth.connection.gaProperty);
  return <section className="ma-card ma-autopilot">
    <div className="ma-row"><div><span className="ma-badge">{site.scheduleEnabled?'Weekly automation on':'Weekly automation paused'}</span><h3>Your growth autopilot</h3></div><button disabled={busy||running} onClick={()=>void act(()=>api(`${path}/growth`,'POST',{}),'Growth review queued. It will save recommendations and at most one draft; it will not publish.')}>Run growth review now</button></div>
    <p>The agent reviews results, checks your website, refreshes browser research and chooses the next useful work. Each weekly cycle prepares at most one suitable blog and records what completed or needs attention.</p>
    <div className="ma-growth-grid">
      <div className="ma-finding"><strong>Business profile</strong><p>{site.profileConfirmed?'Confirmed. Content can use your products and audience.':'Check the product description and audience below to allow writing.'}</p></div>
      <div className="ma-finding"><strong>Traffic measurement</strong><p>{connected?'Google reporting is connected. The next review will read available results.':'Connect Search Console or GA4 to measure outcomes automatically.'}</p><button className="ma-secondary" onClick={()=>onView('results')}>Manage results</button></div>
      <div className="ma-finding"><strong>Website access</strong><p>{data.canPublish?'Owtomate blog publishing is available. Website fixes remain recommendations for review.':'Research and exportable drafts are available. Automatic publishing and website edits need a CMS connector; this website is not connected for those actions yet.'}</p></div>
    </div>
    <form onSubmit={e=>{e.preventDefault();void act(()=>api(path,'PATCH',{growthGoal:goal,growthAIProvider:provider,scheduleEnabled:enabled,publishMode:mode,scheduleDay:day,scheduleTime:time,timezone:zone}),'Growth automation settings saved.');}}>
      <div className="ma-grid"><label>Business goal<select value={goal} onChange={e=>setGoal(e.target.value as typeof goal)}><option value="traffic">Relevant organic traffic</option><option value="leads">Qualified enquiries</option><option value="sales">Product sales</option></select></label>
      <label>Content approval<select value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="review">Save drafts for my review</option>{data.canPublish && <option value="auto">Publish approved blogs automatically</option>}</select></label></div>
      <p className="ma-muted">Your goal guides topic selection and the call to action. Rankings, enquiries and sales depend on the market and are not guaranteed. Website fixes, content refreshes and outreach still need review and implementation.</p>
      <label className="ma-check"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>Run this growth cycle every week</label>
      <details className="ma-custom"><summary>Timing and optional AI checks</summary><div className="ma-grid">
        <label>Day<select value={day} onChange={e=>setDay(Number(e.target.value))}>{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((d,i)=><option key={d} value={i}>{d}</option>)}</select></label>
        <label>Local time<input type="time" required value={time} onChange={e=>setTime(e.target.value)}/></label>
        <label>Timezone<input required value={zone} onChange={e=>setZone(e.target.value)}/></label>
        <label>Weekly browser AI check<select value={provider} onChange={e=>setProvider(e.target.value as typeof provider)}><option value="off">Off</option><option value="Perplexity">Perplexity</option><option value="ChatGPT">ChatGPT</option></select></label>
      </div><p>One discovery prompt per cycle. Login walls and access blocks are recorded as unknown visibility.</p></details>
      <button disabled={busy}>Save growth automation</button>
      {site.nextRunAt && <p>Next cycle: {date(site.nextRunAt)} · {site.timezone}</p>}
      {data.canPublish && <p className="ma-muted">This uses the existing blog schedule. Pausing here also keeps the legacy weekly publisher paused.</p>}
    </form>
    {report && <div className="ma-custom"><h4>Latest growth review</h4><p>{date(report.startedAt)} · {report.completedAt?'Finished':latest.status==='failed'?'Interrupted — review the saved steps':'In progress'}</p><ol className="ma-run-steps">{report.steps.map(step=><li key={step.key}><div className="ma-row"><strong>{step.title}</strong><span className="ma-badge">{{pending:'Waiting',running:'Working',done:'Completed',attention:'Needs attention',skipped:'Skipped'}[step.status]}</span></div><p>{step.summary}</p></li>)}</ol></div>}
    <details className="ma-custom"><summary>How the agent chooses work</summary><ol><li>Use connected measurements as evidence, keeping missing data unknown.</li><li>Flag crawl and page problems, then review existing content before proposing another page.</li><li>Choose an open, relevant topic that fits the business goal. Skip dismissed topics and detected overlap.</li><li>Check source claims before publishing. Hold automatic publishing when the current audit fails or flags urgent findings.</li><li>Stop adding drafts when three are waiting. Revisit results in the next cycle and show what still needs attention.</li></ol></details>
  </section>;
}
