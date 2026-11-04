import { useEffect, useState } from 'react';
import { api } from '../adminApi';
import { EmployerQuestion } from './EmployerQuestion';
import type { AttentionItem } from './AttentionPanel';
import { attentionCopy } from '../attention-copy';
import { blockedQuestionKey } from '../../../seek-bot/src/blocked-question-key';

interface UserDashboard {
  userId: string;
  email: string;
  attention: Array<AttentionItem & {removalRevision: string}>;
  applications: Array<{id: string; status: string; operator_hold?: unknown; application: {
    job:{title:string;company:string;location:string;url:string};resume?:string;coverLetter?:string;
    answers:Array<{question:string;answer:string}>;
  }}>;
}

/** Explicitly targeted support view. Never replaces the admin session with a user session. */
export function AdminUserDashboard({userId,email,onChanged}: {userId:string;email:string;onChanged:()=>void}) {
  // The parent keys this component by owner; late requests cannot update another owner's view.
  const [data,setData]=useState<UserDashboard|null>(null);
  const [refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);
    void api<UserDashboard>(`/users/${userId}/dashboard`,{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted)return;
      if(result.userId!==userId||result.email!==email)throw new Error('Account changed');
      setData(result);setError('');
    }).catch(()=>{if(!controller.signal.aborted)setError('Could not load this user’s dashboard. Refresh to try again.');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[userId,email,refresh]);

  async function remove(item:UserDashboard['attention'][number]) {
    if(busy||loading||!window.confirm(`Remove “${item.title}” from Needs attention for ${email}? Run history and saved answers stay available. New questions may reappear on a later run.`))return;
    setBusy(item.jobId);setError('');setNotice('');
    try {
      const result=await api<{ok:boolean}>(`/users/${userId}/attention`,{method:'DELETE',json:{jobId:item.jobId,revision:item.removalRevision}});
      if(!result.ok)throw new Error('Removal failed');
      setData(current=>current?{...current,attention:current.attention.filter(row=>row.jobId!==item.jobId)}:null);
      setNotice(`Removed “${item.title}” for ${email}.`);onChanged();
    } catch {
      setError('Could not remove this row. Refresh the dashboard and check whether its questions have changed.');
    } finally {setBusy(null);}
  }

  return <section className="section admin-user-dashboard" aria-label={`User dashboard for ${email}`}>
    <h3>User dashboard</h3>
    <p className="job-meta">Viewing and managing <strong>{email}</strong>. Run and schedule controls are below; profile and saved answers follow.</p>
    <button className="btn btn-small" disabled={loading||busy!==null} onClick={()=>setRefresh(value=>value+1)}>{loading?'Loading dashboard…':'Refresh dashboard'}</button>
    {error&&<p className="banner banner-bad" role="alert">{error}</p>}
    {notice&&<p className="banner" role="status">{notice}</p>}
    {data&&<>
      <h4>Needs attention ({data.attention.length})</h4>
      {!data.attention.length&&<p className="job-meta">No questions waiting.</p>}
      {data.attention.map(item=><div className="card section" key={item.jobId}>
        <strong>{item.title}</strong><div className="job-meta">{item.company}</div>
        <details><summary>View employer questions</summary>
          <fieldset disabled style={{border:0,padding:0,minWidth:0}}>
            {item.questions?.filter(question=>question.snapshot).map(question=><EmployerQuestion key={blockedQuestionKey(question)} snapshot={question.snapshot!} value={{}} onChange={()=>{}}/>)}
          </fieldset>
          {item.needsQuestionCapture&&<p>{attentionCopy.recapture}</p>}
        </details>
        <div className="admin-button-row">
          <a href={item.url} target="_blank" rel="noreferrer">Open listing ↗</a>
          <button className="btn btn-small btn-danger" disabled={loading||busy!==null} onClick={()=>void remove(item)} aria-label={`Remove ${item.title} from Needs attention`}>{busy===item.jobId?'Removing…':'Remove row'}</button>
        </div>
      </div>)}
      <h4>Prepared applications ({data.applications.length})</h4>
      <p className="job-meta">Latest 100 saved drafts and outcomes for this user. Viewing a draft does not approve or submit it.</p>
      {data.applications.map(review=><details className="card section" key={review.id}>
        <summary>{review.application.job.title} · {review.application.job.company} · {review.status}{review.operator_hold?' · Held for review':''}</summary>
        <div className="job-meta">{review.application.job.location}</div>
        {review.application.resume&&<p>Resume: {review.application.resume}</p>}
        {review.application.coverLetter&&<><h5>Cover letter</h5><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{review.application.coverLetter}</p></>}
        {review.application.answers.map((answer,index)=><p key={index}><strong>{answer.question}</strong><br/>{answer.answer}</p>)}
        <a href={review.application.job.url} target="_blank" rel="noreferrer">Open listing ↗</a>
      </details>)}
      {!data.applications.length&&<p className="job-meta">No prepared applications.</p>}
    </>}
  </section>;
}
