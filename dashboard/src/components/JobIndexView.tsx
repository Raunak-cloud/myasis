import { useEffect, useState } from 'react';
import { api } from '../adminApi';
import type { IndexedJob, MatchResult } from '../../server/job-index/types';
import './JobIndexView.css';

interface ManualSearch {id:string;provider:'brave'|'codex';state:string;stats:{newJobs?:number;fitUnavailable?:number};error:string|null}
interface Status {enabled:boolean;searchConfigured:boolean;codexConnected?:boolean;searches?:ManualSearch[];counts:{jobs:number;fresh_jobs:number};profiles:number}
interface JobRecord {payload:IndexedJob;first_seen_at?:string;verified_at:string;payload_hash?:string;candidate_match:MatchResult|null;matches?:Array<{userId:string;matchedAt:string;match:MatchResult}>}
interface Results {jobs:JobRecord[];hasMore:boolean}
const tagLabels:Record<keyof IndexedJob['tags'],string>={categories:'Categories',employmentTypes:'Employment types',seniority:'Seniority',suitableFor:'Suitable for',skills:'Skills',requirements:'Requirements'};
const label=(value:string)=>value.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[-_]/g,' ');
const date=(value:string|undefined|null)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-AU',{dateStyle:'medium',timeStyle:'short'}):'Not provided';
function payLabel(pay:IndexedJob['pay']):string {
  if(pay.status==='unpaid')return 'Unpaid';if(pay.status!=='disclosed')return 'Pay not mentioned';
  if(pay.min===null&&pay.max===null)return pay.text;
  const number=(n:number)=>new Intl.NumberFormat('en-AU').format(n);
  return `${pay.currency?pay.currency+' ':''}${pay.min===null?'Up to '+number(pay.max!):number(pay.min)}${pay.max!==null&&pay.min!==null&&pay.max!==pay.min?'–'+number(pay.max):''}${pay.period?' / '+pay.period.toLowerCase():''}`;
}
function JobCard({record}:{record:JobRecord}) {
  const {payload:j}=record;
  const groups=(Object.entries(j.tags) as Array<[keyof IndexedJob['tags'],IndexedJob['tags']['skills']]>).filter(([,tags])=>tags.length);
  return <article className="indexed-job">
    <h2><a href={j.url} target="_blank" rel="noopener noreferrer">{j.title}</a></h2>
    <p className="job-meta">{j.company} · {j.locations.join(' / ')||'Location not mentioned'}</p>
    <p className="indexed-job-summary"><span>{label(j.workArrangement)}</span><span>{payLabel(j.pay)}</span></p>
    <details className="indexed-job-details"><summary>Job details</summary><div className="indexed-job-body">
      <h3>Description</h3><p className="indexed-job-description">{j.description}</p>
      <h3>Details</h3>
      <dl className="indexed-job-facts">
        <dt>Employer</dt><dd>{j.company}</dd>
        <dt>Location</dt><dd>{j.locations.join(' / ')||'Not provided'}</dd>
        <dt>Applicant locations</dt><dd>{j.applicantLocations.join(' / ')||'Not provided'}</dd>
        <dt>Work arrangement</dt><dd>{label(j.workArrangement)}</dd>
        <dt>Pay</dt><dd>{payLabel(j.pay)}</dd>
        <dt>Posted</dt><dd>{date(j.postedAt)}</dd>
        <dt>Closes</dt><dd>{date(j.expiresAt)}</dd>
        <dt>First found</dt><dd>{date(record.first_seen_at)}</dd>
        <dt>Last verified</dt><dd>{date(record.verified_at)}</dd>
        <dt>Source</dt><dd>{label(j.source)}</dd>
        <dt>Source URL</dt><dd><a href={j.url} target="_blank" rel="noopener noreferrer">{j.url}</a></dd>
        {j.sourceId&&<><dt>Source ID</dt><dd>{j.sourceId}</dd></>}
      </dl>
      {groups.length>0&&<><h3>Tags</h3><dl className="indexed-job-facts">{groups.map(([key,tags])=><div className="indexed-job-fact" key={key}><dt>{tagLabels[key]}</dt><dd>{tags.map(t=>t.value).join(', ')}</dd></div>)}</dl></>}
      {!!record.matches?.length&&<><h3>AI matches</h3><div className="indexed-job-matches">{record.matches.map(({userId,matchedAt,match})=><section key={userId} className="indexed-job-match" aria-label={`Match for account ${userId}`}>
        <div className="indexed-job-match-title"><strong>Account {userId}</strong><span className="badge ok">{match.review.score}% match</span></div>
        <p>{match.review.reason}</p>
        <dl className="indexed-job-facts">
          {match.keywords.length>0&&<><dt>Keywords</dt><dd>{match.keywords.join(', ')}</dd></>}
          {match.skills.length>0&&<><dt>Matching skills</dt><dd>{match.skills.join(', ')}</dd></>}
          <dt>Arrangement preference</dt><dd>{match.preferences.arrangement}</dd>
          <dt>Location preference</dt><dd>{match.preferences.location}</dd>
          <dt>Reviewed</dt><dd>{date(matchedAt)}</dd>
          <dt>Model</dt><dd>{match.review.model}</dd>
          <dt>Review policy</dt><dd>{match.review.policy}</dd>
        </dl>
      </section>)}</div></>}
      <details className="indexed-job-evidence"><summary>Source evidence and record metadata</summary>
        <dl className="indexed-job-facts"><dt>Record ID</dt><dd>{j.id}</dd>{record.payload_hash&&<><dt>Snapshot</dt><dd>{record.payload_hash}</dd></>}{Object.entries(j.evidence).map(([key,text])=><div className="indexed-job-fact" key={key}><dt>{label(key)}</dt><dd>{text}</dd></div>)}</dl>
        {groups.map(([key,tags])=><section className="indexed-job-evidence-group" key={key}><h4>{tagLabels[key]}</h4>{tags.map((tag,index)=><div key={`${tag.value}-${index}`}><strong>{tag.value}</strong><span className="job-meta"> · {tag.basis==='inferred'?'Inferred':'Source'}</span><p>{tag.evidence}</p></div>)}</section>)}
      </details>
    </div></details>
  </article>;
}
export function JobIndexView() {
  const [status,setStatus]=useState<Status|null>(null),[results,setResults]=useState<Results|null>(null),[error,setError]=useState('');
  const [query,setQuery]=useState(''),[arrangement,setArrangement]=useState(''),[pay,setPay]=useState(''),[user,setUser]=useState(''),[page,setPage]=useState(0),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  useEffect(()=>{
    let current=true;const params=new URLSearchParams({q:query,page:String(page)});if(arrangement)params.set('arrangement',arrangement);if(pay)params.set('pay',pay);if(user)params.set('user',user);
    const timer=window.setTimeout(()=>{setLoading(true);setResults(null);Promise.all([api<Status>('/job-index/status'),api<Results>(`/job-index?${params}`)]).then(([s,r])=>{if(current){setStatus(s);setResults(r);setError('');}}).catch(e=>{if(current)setError((e as Error).message);}).finally(()=>{if(current)setLoading(false);});},250);
    return()=>{current=false;window.clearTimeout(timer);};
  },[query,arrangement,pay,user,page,revision]);
  const active=status?.searches?.some(s=>['queued','searching','running'].includes(s.state))??false;
  useEffect(()=>{
    let current=true;
    const timer=window.setInterval(()=>{void api<Status>('/job-index/status').then(next=>{if(!current)return;setStatus(next);if(active&&!next.searches?.some(s=>['queued','searching','running'].includes(s.state)))setRevision(v=>v+1);}).catch(()=>{});},active?3000:15000);
    return()=>{current=false;window.clearInterval(timer);};
  },[active]);
  async function toggle(){if(!status)return;setBusy(true);try{await api('/job-index/control',{method:'POST',json:{enabled:!status.enabled}});setRevision(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function search(provider:'brave'|'codex'){setBusy(true);setError('');try{await api('/job-index/search',{method:'POST',json:{provider}});setRevision(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const latest=status?.searches?.[0];
  return <section className="card job-index" aria-label="Saved jobs" aria-busy={loading}>
    <div className="job-index-toolbar">{status&&<p className="job-meta">{status.counts.fresh_jobs.toLocaleString()} matching {status.counts.fresh_jobs===1?'job':'jobs'} · {status.profiles} paid accounts · {status.enabled?'Manual search':'Paused'}</p>}<div className="job-index-actions"><button className="btn" onClick={()=>setRevision(v=>v+1)}>Refresh</button>{status&&<button className="btn" disabled={busy} onClick={()=>void toggle()}>{status.enabled?'Pause crawler':'Resume crawler'}</button>}</div></div>
    {status&&<div className="job-index-actions job-index-search-controls">
      <button className="btn" disabled={busy||active||!status.enabled||!status.searchConfigured} onClick={()=>void search('brave')}>Search with Brave</button>
      <button className="btn" disabled={busy||active||!status.enabled||!status.codexConnected} onClick={()=>void search('codex')}>Search with Codex</button>
      {!status.codexConnected&&<span className="job-meta">Codex connector offline</span>}
    </div>}
    {latest&&<p className="job-meta" role="status">{latest.provider==='codex'?'Codex':'Brave'} · {latest.state==='completed'?`Completed · ${latest.stats.newJobs??0} new matching jobs${latest.stats.fitUnavailable?' · Some reviews unavailable':''}`:latest.state==='failed'?latest.error??'Search could not finish.':latest.state==='queued'?'Queued':latest.state==='searching'?'Searching employer pages…':'Verifying and matching jobs…'}</p>}
    {error&&<div className="banner banner-bad" role="alert">{error}</div>}
    {status&&!status.searchConfigured&&<p className="job-meta">Brave search is not configured.</p>}
    <div className="job-index-filters">
      <input aria-label="Search indexed jobs" placeholder="Search jobs" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/>
      <input aria-label="Account ID for private matches" placeholder="Account ID" inputMode="numeric" value={user} onChange={e=>{setUser(e.target.value.replace(/\D/g,''));setPage(0);}}/>
      <select aria-label="Work arrangement" value={arrangement} onChange={e=>{setArrangement(e.target.value);setPage(0);}}><option value="">All arrangements</option>{['remote','hybrid','onsite','not-mentioned'].map(v=><option key={v} value={v}>{label(v)}</option>)}</select>
      <select aria-label="Pay information" value={pay} onChange={e=>{setPay(e.target.value);setPage(0);}}><option value="">All pay information</option><option value="disclosed">Pay disclosed</option><option value="not-mentioned">Pay not mentioned</option><option value="unpaid">Unpaid</option></select>
    </div>
    {loading&&<p className="job-meta" role="status">Loading jobs…</p>}
    {results?.jobs.map(record=><JobCard key={record.payload.id} record={record}/>)}
    {results&&!results.jobs.length&&<p className="job-meta">No matching jobs found.</p>}
    <div className="job-index-actions job-index-pagination"><button className="btn" disabled={loading||page===0} onClick={()=>setPage(v=>v-1)}>Previous</button><button className="btn" disabled={loading||!results?.hasMore} onClick={()=>setPage(v=>v+1)}>Next</button></div>
  </section>;
}
