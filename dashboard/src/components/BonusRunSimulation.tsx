import {useState} from 'react';
import {MascotLogo} from './MascotLogo';
import './BonusRunSimulation.css';

type Mode='auto'|'semi-auto';
type Stage='ready'|'queued'|'searching'|'applying'|'completed'|'attention'|'stopped';
type Setup={customer:string;mode:Mode;limit:number;message:string;hasActiveRun:boolean};
const customers=[{name:'Alex Morgan',email:'alex@example.invalid',credits:20},{name:'Jordan Lee',email:'jordan@example.invalid',credits:0}];
const initial:Setup={customer:'0',mode:'auto',limit:10,message:'A complimentary run from Owtomate. Good luck with your search!',hasActiveRun:false};
const stages:Array<{id:Stage;label:string}>=[{id:'queued',label:'Queued'},{id:'searching',label:'Searching'},{id:'applying',label:'In progress'},{id:'completed',label:'Completed'},{id:'attention',label:'Needs attention'},{id:'stopped',label:'Stopped'}];

function Gift(){return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 10v11h16V10M2 6h20v4H2zM12 6v15"/><path d="M12 6H7.5A2.5 2.5 0 1 1 10 3.5L12 6Zm0 0h4.5A2.5 2.5 0 1 0 14 3.5L12 6Z"/></svg>}
function BonusBadge(){return <span className="bonus-badge"><Gift/>Bonus run</span>}

/** Admin-only design simulation. Every action stays in local component state. */
export function BonusRunSimulation(){
 const [setup,setSetup]=useState<Setup>(initial),[started,setStarted]=useState<Setup|null>(null);
 const [stage,setStage]=useState<Stage>('ready'),[phone,setPhone]=useState(false),[showApplications,setShowApplications]=useState(false);
 const [stoppedCount,setStoppedCount]=useState(0);
 const [showQuestion,setShowQuestion]=useState(false),[answer,setAnswer]=useState(''),[confirmStop,setConfirmStop]=useState(false);
 const current=started??setup,customer=customers[Number(current.customer)],semi=current.mode==='semi-auto';
 const active=['queued','searching','applying'].includes(stage),finished=['completed','attention','stopped'].includes(stage);
 const count=stage==='completed'?Math.min(current.limit,6):stage==='attention'?Math.min(current.limit,3):stage==='stopped'?stoppedCount:stage==='applying'?Math.min(current.limit,2):0;
 const action=semi?'prepared':'submitted';
 const applications=`${count} application${count===1?'':'s'}`;
 const title=stage==='queued'?'Your bonus run is next':stage==='searching'?'Your bonus run is finding jobs':stage==='applying'?semi?'Preparing your applications':'Applying to your matches':stage==='completed'?'Your bonus run is complete':stage==='attention'?'One application needs your answer':'Your bonus run was stopped';
 const copy=stage==='queued'?'Your current run will finish first. Your bonus run will start after it.':stage==='searching'?'Looking across SEEK, Indeed and employer sites using your saved preferences.':stage==='applying'?semi?'We’re preparing suitable applications for you to review and approve.':'We’re completing suitable applications and checking employer confirmations.':stage==='completed'?semi?`${applications} ${count===1?'is':'are'} ready for your approval. They stay complimentary when you approve them.`:`${applications} submitted. We found ${count} suitable job${count===1?'':'s'} for your saved preferences.`:stage==='attention'?'Please answer the employer’s question so this application can continue.':count===0?`The run has ended. No applications were ${action}.`:`The run has ended. Your ${semi?'prepared':'submitted'} applications are still available.`;
 function start(){setStoppedCount(0);setStarted({...setup});setStage(setup.hasActiveRun?'queued':'searching');setShowQuestion(false);setAnswer('');setShowApplications(false);}
 function changeStage(next:Stage){if(next==='stopped')setStoppedCount(Math.min(current.limit,2));if(!started)setStarted({...setup});setStage(next);setConfirmStop(false);setShowApplications(false);setShowQuestion(false);setAnswer('');}
 function reset(){setStoppedCount(0);setStarted(null);setStage('ready');setShowApplications(false);setShowQuestion(false);setAnswer('');setConfirmStop(false);}
 return <section className="bonus-run-simulation" aria-label="Bonus run simulation">
  <header className="bonus-heading"><div><p className="bonus-eyebrow">ADMIN PREVIEW</p><h2>Give someone an extra run.</h2><p className="bonus-muted">Start it for them. Make it clearly complimentary.</p></div><span className="bonus-preview-tag">Simulation only</span></header>
  <p className="bonus-simulation-note">Fictional accounts and applications. No run starts, no email is sent and no account or credit balance changes.</p>
  <div className="bonus-workspace">
   <aside className="bonus-admin" aria-label="Bonus run admin controls">
    <div className="bonus-admin-title"><span className="bonus-step">1</span><div><h3>Admin controls</h3><p className="bonus-muted">From the user’s account in Admin</p></div></div>
    <fieldset disabled={started!==null} className="bonus-settings">
     <label>Customer<select aria-label="Customer" className="input" value={setup.customer} onChange={event=>setSetup({...setup,customer:event.target.value})}>{customers.map((item,index)=><option key={item.email} value={index}>{item.name}</option>)}</select><small>{customers[Number(setup.customer)].email}</small></label>
     <label>Application mode<select aria-label="Application mode" className="input" value={setup.mode} onChange={event=>setSetup({...setup,mode:event.target.value as Mode})}><option value="auto">Auto apply</option><option value="semi-auto">Semi auto</option></select><small>Uses the customer’s saved mode by default.</small></label>
     <label>Maximum applications<input aria-label="Maximum applications" className="input" type="number" min="1" max="50" value={setup.limit} onChange={event=>setSetup({...setup,limit:Math.max(1,Math.min(50,Number(event.target.value)||1))})}/><small>A maximum, not a guaranteed number of matches.</small></label>
     <label>Message shown to the customer <span className="bonus-optional">(optional)</span><textarea aria-label="Message shown to the customer (optional)" className="input" rows={3} maxLength={240} value={setup.message} onChange={event=>setSetup({...setup,message:event.target.value})}/></label>
     <label className="bonus-check"><input type="checkbox" checked={setup.hasActiveRun} onChange={event=>setSetup({...setup,hasActiveRun:event.target.checked})}/>Preview a customer with a run already active</label>
    </fieldset>
    <div className="bonus-free-note"><Gift/><div><strong>Fully complimentary</strong><span>No application credits used. No normal run allowance used. No change to the customer’s schedule.</span></div></div>
    {!started?<button type="button" className="btn primary bonus-start" onClick={start}><Gift/>Start bonus run</button>:<><div className="bonus-admin-result" role="status"><strong>{stage==='queued'?'Bonus run queued':active?'Bonus run in progress':stage==='stopped'?'Bonus run stopped':'Bonus run finished'}</strong><span>{customer.name} · {semi?'Semi auto':'Auto apply'} · Up to {current.limit} application{current.limit===1?'':'s'}</span></div><button type="button" className="btn bonus-reset" onClick={reset}>Reset simulation</button></>}
    <p className="bonus-admin-footnote">The customer’s saved search preferences, resume and account connections apply. Semi auto still asks for approval before submission.</p>
   </aside>
   <div className="bonus-preview-column">
    <div className="bonus-preview-toolbar"><div><span className="bonus-step">2</span><strong>What the customer sees</strong></div><div className="bonus-device-switch" role="group" aria-label="Customer preview size"><button type="button" aria-pressed={!phone} onClick={()=>setPhone(false)}>Desktop</button><button type="button" aria-pressed={phone} onClick={()=>setPhone(true)}>Phone</button></div></div>
    <div className={`bonus-customer-frame${phone?' is-phone':''}`} role="region" aria-label="Customer dashboard preview">
     <div className="bonus-customer-brand"><div><MascotLogo size={29}/><strong>owtomate</strong></div><span className="bonus-avatar" title={customer.name}>{customer.name.split(' ').map(part=>part[0]).join('')}</span></div>
     <nav className="bonus-customer-tabs" aria-label="Preview dashboard tabs"><span className="selected">Apply</span><span>Applications</span><span>Profile</span></nav>
     <div className="bonus-customer-content">
      <div className="bonus-greeting"><div><h3>Your applications</h3><p className="bonus-muted">Let’s find your next opportunity, {customer.name.split(' ')[0]}.</p></div></div>
      {stage==='ready'?<div className="bonus-empty"><span className="bonus-empty-icon"><Gift/></span><strong>Your next scheduled run is tomorrow</strong><p>Your applications and saved preferences are ready.</p></div>:<article className={`bonus-customer-card stage-${stage}`} aria-label="Customer bonus run">
       <div className="bonus-card-top"><BonusBadge/><span className="bonus-status"><i/>{stage==='queued'?'Queued':stage==='searching'?'Finding jobs':stage==='applying'?'In progress':stage==='completed'?'Completed':stage==='attention'?'Needs attention':'Stopped'}</span></div>
       <h4>{title}</h4><p className="bonus-card-copy">{copy}</p>
       {current.message.trim()&&<blockquote>{current.message}</blockquote>}
       <div className="bonus-run-details"><span>{semi?'Semi auto':'Auto apply'}</span><span>Up to {current.limit} application{current.limit===1?'':'s'}</span><span>Started by Owtomate</span></div>
       {(stage==='searching'||stage==='applying')&&<div className="bonus-progress" aria-label="Bonus run progress"><span style={{width:stage==='searching'?'22%':`${Math.max(32,count/current.limit*100)}%`}}/></div>}
       {(count>0||stage==='searching')&&<div className="bonus-counters"><div><strong>{stage==='searching'?12:stage==='completed'?42:28}</strong><span>Jobs reviewed</span></div><div><strong>{count}</strong><span>Applications {action}</span></div></div>}
       <div className="bonus-customer-free"><span>✓ This bonus run won’t use any of your application credits or regular runs.</span></div>
       {active&&<button type="button" className="btn bonus-stop" onClick={()=>setConfirmStop(true)}>Stop bonus run</button>}
       {stage==='attention'&&<button type="button" className="btn primary" onClick={()=>setShowQuestion(value=>!value)}>Review question</button>}
       {finished&&count>0&&<button type="button" className="btn" onClick={()=>setShowApplications(value=>!value)}>{semi?'Review prepared applications':'View applications'}</button>}
       {confirmStop&&<div className="bonus-inline-dialog" role="alertdialog" aria-label="Stop bonus run?"><strong>Stop bonus run?</strong><p>The current application may be left unfinished. Applications already {action} will stay available.</p><div><button className="btn" type="button" onClick={()=>setConfirmStop(false)}>Keep running</button><button className="btn" type="button" onClick={()=>{setStoppedCount(count);setStage('stopped');setConfirmStop(false);}}>Stop this run</button></div></div>}
       {showQuestion&&<div className="bonus-question"><strong>Data Analyst · Example employer</strong><fieldset><legend>Are you available for a rostered Saturday shift?</legend>{['Yes','No'].map(value=><label key={value}><input type="radio" name="bonus-question" value={value} checked={answer===value} onChange={()=>setAnswer(value)}/>{value}</label>)}</fieldset><button type="button" className="btn primary" disabled={!answer} onClick={()=>{setShowQuestion(false);setStage('applying');}}>Save answer &amp; continue</button></div>}
      </article>}
      {showApplications&&<section className="bonus-application-list" aria-label="Bonus applications"><h4>{semi?'Ready for your approval':'From your bonus run'}</h4>{['Data Analyst','Business Intelligence Analyst','Reporting Analyst','Insights Analyst','Operations Analyst','Analytics Consultant'].slice(0,count).map(title=><div key={title}><strong>{title}</strong><span>Example employer · Sydney</span><div><BonusBadge/><span>{semi?'Prepared for approval':'Applied'}</span></div></div>)}{semi&&<p>Review and approve these applications from your Applications page. No application credits will be used.</p>}</section>}
      <section className="bonus-history" aria-label="Customer run history"><h4>Recent runs</h4>{started&&<div className="bonus-history-row"><div><BonusBadge/><span>Today · {semi?'Semi auto':'Auto apply'}</span></div><div><strong>{active?stage==='queued'?'Queued':'In progress':stage==='attention'?'Needs attention':stage==='stopped'?'Stopped':'Completed'}</strong><span>{count} {action} · Complimentary</span></div></div>}<div className="bonus-history-row"><div><strong>Scheduled run</strong><span>Today · 9:00 am</span></div><div><strong>{stage==='queued'?'In progress':'Completed'}</strong><span>{stage==='queued'?'Finishing the current run':'4 applications submitted'}</span></div></div></section>
     </div>
    </div>
    <div className="bonus-stage-controls"><span>Preview a run state</span><div role="group" aria-label="Bonus run preview states">{stages.map(item=><button type="button" key={item.id} aria-pressed={stage===item.id} onClick={()=>changeStage(item.id)}>{item.label}</button>)}</div><small>Preview controls are only visible to admins. Customers see the dashboard above.</small></div>
   </div>
  </div>
 </section>;
}
