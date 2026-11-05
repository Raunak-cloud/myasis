import { useEffect, useState } from 'react';
import { api } from '../adminApi';
import type { IndexedJob, MatchResult } from '../../server/job-index/types';
import './JobIndexView.css';

interface Status {enabled:boolean;searchConfigured:boolean;counts:{jobs:number;fresh_jobs:number};profiles:number;cycles:Array<{status:string;finished_at:string|null;error:string|null}>}
interface Results {jobs:Array<{payload:IndexedJob;verified_at:string;candidate_match:MatchResult|null}>;hasMore:boolean}
function payLabel(pay:IndexedJob['pay']):string {
  if(pay.status==='unpaid')return 'Unpaid';if(pay.status!=='disclosed')return 'Pay not mentioned';
  if(pay.min===null&&pay.max===null)return pay.text;
  const number=(n:number)=>new Intl.NumberFormat('en-AU').format(n);
  return `${pay.currency?pay.currency+' ':''}${pay.min===null?'Up to '+number(pay.max!):number(pay.min)}${pay.max!==null&&pay.min!==null&&pay.max!==pay.min?'–'+number(pay.max):''}${pay.period?' / '+pay.period.toLowerCase():''}`;
}
export function JobIndexView() {
  const [status,setStatus]=useState<Status|null>(null),[results,setResults]=useState<Results|null>(null),[error,setError]=useState('');
  const [query,setQuery]=useState(''),[arrangement,setArrangement]=useState(''),[pay,setPay]=useState(''),[user,setUser]=useState(''),[page,setPage]=useState(0),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false);
  useEffect(()=>{
    let current=true;const params=new URLSearchParams({q:query,page:String(page)});if(arrangement)params.set('arrangement',arrangement);if(pay)params.set('pay',pay);if(user)params.set('user',user);
    const timer=window.setTimeout(()=>{Promise.all([api<Status>('/job-index/status'),api<Results>(`/job-index?${params}`)]).then(([s,r])=>{if(current){setStatus(s);setResults(r);setError('');}}).catch(e=>{if(current)setError((e as Error).message);});},250);
    return()=>{current=false;window.clearTimeout(timer);};
  },[query,arrangement,pay,user,page,revision]);
  async function toggle(){if(!status)return;setBusy(true);try{await api('/job-index/control',{method:'POST',json:{enabled:!status.enabled}});setRevision(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section className="card admin-section job-index">
    <div className="admin-button-row" style={{justifyContent:'space-between',alignItems:'center'}}><div><h2>Job index</h2>{status&&<p className="job-meta">{status.counts.fresh_jobs.toLocaleString()} indexed {status.counts.fresh_jobs===1?'job':'jobs'} · {status.profiles} paid accounts · {status.enabled?'Collecting':'Paused'}</p>}</div><div className="admin-button-row"><button className="btn" onClick={()=>setRevision(v=>v+1)}>Refresh</button>{status&&<button className="btn" disabled={busy} onClick={()=>void toggle()}>{status.enabled?'Pause crawler':'Resume crawler'}</button>}</div></div>
    {error&&<div className="banner banner-bad" role="alert">{error}</div>}
    {status&&!status.searchConfigured&&<p className="job-meta">Employer feeds enabled. Web search needs a search-provider key.</p>}
    <div className="job-index-filters">
      <input aria-label="Search indexed jobs" placeholder="Search jobs" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/>
      <input aria-label="Account ID for private matches" placeholder="Account ID" inputMode="numeric" value={user} onChange={e=>{setUser(e.target.value.replace(/\D/g,''));setPage(0);}}/>
      <select aria-label="Work arrangement" value={arrangement} onChange={e=>{setArrangement(e.target.value);setPage(0);}}><option value="">All arrangements</option>{['remote','hybrid','onsite','not-mentioned'].map(v=><option key={v} value={v}>{v.replace('-', ' ')}</option>)}</select>
      <select aria-label="Pay information" value={pay} onChange={e=>{setPay(e.target.value);setPage(0);}}><option value="">All pay information</option><option value="disclosed">Pay disclosed</option><option value="not-mentioned">Pay not mentioned</option><option value="unpaid">Unpaid</option></select>
    </div>
    {results?.jobs.map(({payload:j,verified_at,candidate_match})=><article key={j.id} style={{padding:'18px 0',borderTop:'1px solid var(--border, #dbe2ec)'}}>
      <a href={j.url} target="_blank" rel="noopener noreferrer"><strong>{j.title}</strong></a><p className="job-meta">{j.company} · {j.locations.join(' / ')||'Location not mentioned'}</p>
      <p>{j.workArrangement.replace('-', ' ')} · {payLabel(j.pay)}</p>
      <p className="job-meta">{[...j.tags.categories,...j.tags.employmentTypes,...j.tags.seniority,...j.tags.suitableFor].map(t=>t.value).join(' · ')}</p>
      <details><summary>Job details</summary><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{j.description}</p>{Object.entries(j.tags).filter(([,tags])=>tags.length).map(([key,tags])=><p key={key}><strong>{key==='suitableFor'?'Suitable for':key}: </strong>{tags.map((t,i)=><span key={t.value+i} title={`${t.basis}: ${t.evidence}`}>{i?', ':''}{t.value}</span>)}</p>)}{j.applicantLocations.length>0&&<p>Applicant location: {j.applicantLocations.join(', ')}</p>}{candidate_match&&<p>Discovery match · {candidate_match.review.reason} · application review still required</p>}<p className="job-meta">Verified {new Date(verified_at).toLocaleString()} · {j.source}</p></details>
    </article>)}
    {results&&!results.jobs.length&&<p className="job-meta">No indexed jobs match these filters.</p>}
    <div className="admin-button-row"><button className="btn" disabled={page===0} onClick={()=>setPage(v=>v-1)}>Previous</button><button className="btn" disabled={!results?.hasMore} onClick={()=>setPage(v=>v+1)}>Next</button></div>
  </section>;
}
