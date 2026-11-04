import {useState} from 'react';
import {PriorRunRepairNotice} from './PriorRunRepairNotice';
type Stage='ready'|'fixing'|'applied'|'attention';
export function PriorRunRepairSimulation(){
 const [stage,setStage]=useState<Stage>('ready');
 return <section className="card admin-section" aria-label="Prior-run recovery simulation">
  <h3>Owtobot prior-run recovery</h3>
  <p className="job-meta">Simulation only. These applications are fictional. No account is changed and nothing is submitted.</p>
  <div className="security-retry-preview-controls" role="group" aria-label="Recovery simulation stages">
   {(['ready','fixing','applied','attention'] as Stage[]).map(value=><button type="button" key={value} className={`chip${stage===value?' on':''}`} aria-pressed={stage===value} onClick={()=>setStage(value)}>
    {{ready:'Issues found',fixing:'Fixing issues',applied:'Confirmed submissions',attention:'Needs attention'}[value]}</button>)}
  </div>
  {stage==='ready'?<><p>Three previously approved applications failed before submission and are eligible for recovery.</p><button className="btn primary" onClick={()=>setStage('fixing')}>Start simulated recovery</button></>:<PriorRunRepairNotice count={3} active={stage==='fixing'}/>}
  <ol>{['Data Governance Analyst','Senior Renewable Fuel Analyst','Senior Data Analyst'].map(title=><li key={title}><strong>{title}</strong> · Example employer · {stage==='ready'?'Approved, not submitted':stage==='fixing'?'Checking saved answers and documents':stage==='applied'?'Applied, employer confirmation received':'Required employer question needs the candidate'}</li>)}</ol>
  {stage==='fixing'&&<p className="job-meta">The applying agent repairs the existing application. The recovery reviewer advises when needed. Existing approval and submission checks still apply.</p>}
 </section>;
}
