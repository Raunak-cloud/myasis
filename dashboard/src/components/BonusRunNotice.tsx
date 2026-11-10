import {useEffect,useState} from 'react';
import {BONUS_RUN_MESSAGE,type BonusRun} from '../bonus-run';
import './BonusRunNotice.css';

export function BonusRunNotice(){
 const [confirming,setConfirming]=useState(false);
 const [runs,setRuns]=useState<BonusRun[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let alive=true;const refresh=()=>void fetch('/api/bonus-runs').then(async response=>{if(!response.ok)throw Error('Unavailable');return response.json();}).then(data=>{if(alive&&Array.isArray(data.runs))setRuns(data.runs);}).catch(()=>{});
  refresh();const timer=window.setInterval(refresh,5000);return()=>{alive=false;window.clearInterval(timer);};
 },[]);
 if(!runs.length)return null;
 const current=runs.find(run=>['queued','starting','running'].includes(run.status))??runs[0];
 const active=['queued','starting','running'].includes(current.status),semi=current.applicationMode==='semi-auto';
 async function stop(){
  if(busy)return;setBusy(true);setError('');
  try{const response=await fetch('/api/bonus-runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancel',id:current.id})});const body=await response.json();if(!response.ok)throw Error(body.error??'Could not stop this bonus run.');setRuns(body.runs);}
  catch(reason){setError((reason as Error).message);}finally{setBusy(false);setConfirming(false);}
 }
 const label=current.status==='starting'||current.status==='queued'?'Queued':current.status==='running'?'In progress':current.status==='completed'?'Completed':current.status==='stopped'?'Stopped':'Not completed';
 return <section className="card bonus-live" aria-label="Your bonus run"><div className="bonus-live-head"><strong className="bonus-run-tag">Bonus run</strong><span>{label}</span></div>
  <h3>{current.status==='running'?'Your bonus run is in progress':current.status==='queued'||current.status==='starting'?'Your bonus run is queued':current.status==='completed'?'Your bonus run is complete':current.status==='stopped'?'Your bonus run was stopped':'Your bonus run ended before completion'}</h3>
  <p>{BONUS_RUN_MESSAGE}</p>{current.message&&<blockquote>{current.message}</blockquote>}
  <p className="job-meta">{semi?'Semi auto':'Auto apply'} · Up to {current.maxApplications} applications · Started by Owtomate</p>
  {current.status==='queued'&&<p className="job-meta">Your current run can finish first. This bonus run starts when your account and a run slot are available.</p>}
  {!active&&<p>{semi?`${current.prepared} applications prepared for your approval. They stay complimentary when you approve them.`:`${current.applied} applications submitted.`}</p>}
  {active&&<button type="button" className="btn btn-small" disabled={busy} onClick={()=>setConfirming(true)}>{busy?'Stopping…':'Stop bonus run'}</button>}
  {confirming&&<div role="alertdialog" aria-label="Stop bonus run?"><p>The current application may be left unfinished. Applications already submitted or prepared will stay available.</p><div className="admin-button-row"><button type="button" className="btn" disabled={busy} onClick={()=>setConfirming(false)}>Keep running</button><button type="button" className="btn" disabled={busy} onClick={()=>void stop()}>Stop this run</button></div></div>}
  {error&&<p role="alert">{error}</p>}
  <details><summary>Bonus run history</summary>{runs.map(run=><div className="bonus-live-history" key={run.id}><span className="bonus-run-tag">Bonus run</span><span>{new Date(run.createdAt).toLocaleDateString('en-AU',{timeZone:'Australia/Sydney'})} · {run.status==='error'?'Not completed':run.status} · {run.applicationMode==='auto'?`${run.applied} submitted`:`${run.prepared} prepared`}</span></div>)}</details>
 </section>;
}
