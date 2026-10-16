import type { MarketingWorkspace, WebsitePatch } from '../marketingTypes';
import { marketingApi as api } from './marketingApi';

const labels:Record<keyof WebsitePatch,string>={title:'Page title',description:'Search description',h1:'Main heading',canonical:'Canonical URL',lang:'Document language',summary:'Answer summary',links:'Related links',structuredData:'WebPage structured data',repairJsonLd:'Repair invalid structured data'};
const display=(value:unknown)=>value==null || value===''?'Not set':typeof value==='boolean'?(value?'Enabled':'Disabled'):typeof value==='string'?value:JSON.stringify(value,null,2);
export function WebsiteChanges({data,path,disabled,act}:{data:MarketingWorkspace;path:string;disabled:boolean;act:(work:()=>Promise<unknown>,message?:string)=>Promise<boolean>}) {
  const execution=data.execution;
  if(!execution) return null;
  const work=(operation:string,changeId?:string)=>act(()=>api(`${path}/improvements`,'POST',{operation,changeId}),'Website work queued. Its result will appear here after public verification.');
  return <section className="ma-card">
    <div className="ma-row"><h3>Website changes</h3><button disabled={disabled || !execution.available || !data.site.profileConfirmed} onClick={()=>void work('prepare')}>Prepare website improvements</button></div>
    <p>{execution.reason}</p>
    {execution.available && <>
      <p>The agent can update your public homepage, guide and blog pages. It checks the current page before applying, then reads the public URL to verify the result. A saved edit and a verified edit have separate statuses.</p>
      <label>Website improvement mode<select disabled={disabled || !data.site.profileConfirmed} value={data.site.improvementMode || 'review'} onChange={e=>void act(()=>api(path,'PATCH',{improvementMode:e.target.value}),'Website improvement mode saved.')}>
        <option value="review">Prepare changes for my review</option><option value="auto">Apply and verify supported changes during growth reviews</option>
      </select></label>
      <p className="ma-muted">Use Growth autopilot to schedule these reviews weekly. Indexing exclusions, crawler access policies, unavailable pages, legal pages and image descriptions still require manual work.</p>
      <details><summary>Supported improvements</summary><ul>{execution.capabilities.map(c=><li key={c}>{c}</li>)}</ul></details>
    </>}
    {!execution.changes.length && <p>No website changes prepared yet. Run a health check, confirm your website profile, then prepare improvements.</p>}
    {execution.changes.map(change=><article className="ma-finding" key={change.id}>
      <div className="ma-row"><h4>{change.title}</h4><span className="ma-badge">{{proposed:'Ready for review',applied:'Saved · verification needed',verified:'Verified on public page',rolled_back:'Rolled back',conflict:'Page changed · prepare again',dismissed:'Dismissed'}[change.status]}</span></div>
      <a href={change.url} target="_blank" rel="noreferrer">{change.url} ↗</a>
      <details open={change.status==='proposed'}><summary>Before and after</summary><div className="ma-table-wrap"><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
        {(Object.keys(change.after) as Array<keyof WebsitePatch>).filter(key=>JSON.stringify(change.before[key])!==JSON.stringify(change.after[key])).map(key=><tr key={key}><th>{labels[key]}</th><td style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{display(change.original?.[key] ?? change.before[key])}</td><td style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{display(change.after[key])}</td></tr>)}
      </tbody></table></div></details>
      {change.error && <p role="status">{change.error}</p>}
      {change.verification && <details><summary>{change.verification.passed?'Public verification passed':'Public verification needs attention'} · {new Date(change.verification.checkedAt).toLocaleString()}</summary><ul>{change.verification.checks.map((c,i)=><li key={i}>{c}</li>)}</ul></details>}
      <div className="ma-actions">
        {change.status==='proposed' && <><button disabled={disabled} onClick={()=>void work('apply',change.id)}>Apply this change</button><button className="ma-secondary" disabled={disabled} onClick={()=>void work('dismiss',change.id)}>Dismiss proposal</button></>}
        {(change.status==='applied'||change.status==='verified') && <><button className="ma-secondary" disabled={disabled} onClick={()=>void work('verify',change.id)}>Verify public page</button><button className="ma-secondary" disabled={disabled} onClick={()=>void work('rollback',change.id)}>Roll back this change</button></>}
      </div>
    </article>)}
  </section>;
}
