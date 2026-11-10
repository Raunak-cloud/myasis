import {useEffect,useRef,useState} from 'react';
import {api} from '../adminApi';
import {BONUS_RUN_MESSAGE,type BonusRun} from '../bonus-run';

export function AdminBonusRun({userId,mode}:{userId:string;mode:'auto'|'semi-auto'}){
 const [maxApplications,setMaxApplications]=useState(10),[applicationMode,setApplicationMode]=useState(mode);
 const [message,setMessage]=useState('A complimentary run from Owtomate.'),[discount,setDiscount]=useState(0);
 const [runs,setRuns]=useState<BonusRun[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const requestId=useRef(crypto.randomUUID());
 useEffect(()=>{let alive=true;const refresh=()=>void api<{runs:BonusRun[]}>(`/users/${userId}/bonus-runs`).then(value=>{if(alive&&Array.isArray(value.runs))setRuns(value.runs);}).catch(()=>{});refresh();const timer=window.setInterval(refresh,5000);return()=>{alive=false;window.clearInterval(timer);};},[userId]);
 async function start(){
  if(busy)return;setBusy(true);setError('');setNotice('');
  try{
   const result=await api<{runs:BonusRun[]}>(`/users/${userId}/bonus-run`,{method:'POST',json:{requestId:requestId.current,options:{maxApplications,applicationMode,message,salaryDiscountPercent:discount}}});
   setRuns(result.runs);setNotice('Bonus run added. It will start when this account and a run slot are available.');requestId.current=crypto.randomUUID();
  }catch(reason){setError((reason as Error).message);}finally{setBusy(false);}
 }
 return <section className="section" aria-label="Admin bonus run"><h3>Bonus run</h3><p className="job-meta">{BONUS_RUN_MESSAGE} Saved search preferences and account connections still apply.</p>
  <div className="admin-button-row"><label>Maximum applications <input className="input" type="number" min={1} max={50} value={maxApplications} disabled={busy} onChange={e=>setMaxApplications(Number(e.target.value))}/></label>
   <label>Application mode <select className="input" value={applicationMode} disabled={busy} onChange={e=>setApplicationMode(e.target.value as 'auto'|'semi-auto')}><option value="auto">Auto apply</option><option value="semi-auto">Semi auto</option></select></label></div>
  <label>Customer message (optional)<textarea className="input" rows={2} maxLength={240} value={message} disabled={busy} onChange={e=>setMessage(e.target.value)}/></label>
  <label>Minimum salary reduction for this run only (%)<input className="input" type="number" min={0} max={10} step={1} value={discount} disabled={busy} onChange={e=>setDiscount(Number(e.target.value))}/></label>
  <p className="job-meta">0 keeps the saved minimum salary. A reduction never changes the saved preference or other matching requirements. Semi auto still needs the customer’s approval.</p>
  <button className="btn primary" disabled={busy||!Number.isInteger(maxApplications)||maxApplications<1||maxApplications>50||!Number.isFinite(discount)||discount<0||discount>10} onClick={()=>void start()}>{busy?'Adding bonus run…':'Start bonus run'}</button>
  {error&&<p className="banner banner-bad" role="alert">{error}</p>}{notice&&<p className="banner" role="status">{notice}</p>}
  {runs.length>0&&<details><summary>Bonus run history ({runs.length})</summary>{runs.map(run=><p key={run.id}><strong>Bonus run</strong> · {run.status} · {run.applicationMode==='auto'?`${run.applied} submitted`:`${run.prepared} prepared`} · Up to {run.maxApplications} applications</p>)}</details>}
 </section>;
}
