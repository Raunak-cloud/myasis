import {createHash} from 'node:crypto';
import {observe} from './observe.js';
import {nativeSnapshot} from './native-browser.js';
import {readSavedForm} from './saved-form.js';
import {privateAuthenticationValues,redactPrivateAuthenticationData} from '../private-auth-fields.js';
import {consultApplicationSpecialist,type ConsultationOptions} from './consultation.js';
import {ok,type ToolContext,type ToolResult} from './context.js';

/** A bounded view, not a head-only truncation: document/validation sections
 * below a long CV remain available to BOTH the parent and the reviewer. */
export function recoveryEvidenceText(text:string):string {
 if(text.length<=50_000)return text;
 const spans:Array<[number,number]>=[[0,8000],[Math.max(0,text.length-8000),text.length]];
 // Separate quotas prevent a repeated "required" label from crowding out
 // document evidence; reserve room for the final page section as well.
 for(const pattern of [/cover\s*letter|supporting documents/gi,/attachments?|document uploads/gi,/validation|invalid|required/gi,/submit your application|application (?:submitted|received)/gi]){
  let count=0;
  for(const match of text.matchAll(pattern)){
   if(count++>=4)break;
   spans.push([Math.max(0,match.index!-500),Math.min(text.length,match.index!+1100)]);
  }
 }
 const merged:Array<[number,number]>=[];
 for(const span of spans.sort((a,b)=>a[0]-b[0])){
  const last=merged.at(-1);if(last&&span[0]<=last[1])last[1]=Math.max(last[1],span[1]);else merged.push([...span]);
 }
 return merged.map(([a,b])=>`[Observed characters ${a}-${b}]\n${text.slice(a,b)}`).join('\n[Other page text omitted; inspect a specific section if needed.]\n');
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const semanticSnapshot=(text:string)=>text.replace(/\s*\[ref=[^\]]+\]/g,'').replace(/\s+/g,' ').trim();
const reviewing=new WeakSet<ToolContext>();

/** One serial, read-only consultation path for manual help, stalled work and
 * proposed stops. No browser reload/navigation or live executor is exposed.
 * The applying loop awaits this whole function before any next browser write. */
export async function reviewApplicationRecovery(ctx:ToolContext,args:{question:string;focus?:'form'|'candidate-evidence'},
 options:ConsultationOptions & {proposedStop?:Record<string,unknown>}):Promise<ToolResult>{
 if(ctx.submissionAttempted&&(options.trigger==='automatic'||options.proposedStop))return ok('A send may already have occurred. Investigate employer evidence read-only; no automatic recovery review or repeat send started.','reobserve');
 if(reviewing.has(ctx)||options.state?.inFlight)return ok('A recovery review is already in progress; no second review started.','reobserve');
 if(options.meter.exhausted)return ok('Recovery review was not started: the shared application budget is exhausted. Preserve a truthful technical checkpoint.','reobserve');
 reviewing.add(ctx);
 try {
 const page=ctx.page;
 const capture=async()=>{
  ctx.recoveryRecord?.assertWriter();
  const observation=await observe(page);
  if(observation.inspectionError)throw Error('Current application evidence could not be inspected.');
  const form=await readSavedForm(page),snapshot=await nativeSnapshot(page,5000);
  const secrets=await privateAuthenticationValues(page);
  const material=redactPrivateAuthenticationData({url:observation.url,title:observation.title,
   fields:form.fields.filter(f=>!f.sensitive&&!f.privateKind&&f.inputType!=='password').map(({ref,...field})=>field),
   snapshot:semanticSnapshot(snapshot),text:form.text},secrets);
  const id='review-evidence:'+digest(material);
  return {observation,id,secrets,text:recoveryEvidenceText(JSON.stringify(material))};
 };
 const before=await capture();ctx.observation=before.observation;
 const packet={id:before.id,text:before.text};ctx.observation.reviewEvidence=packet;
 const result=await consultApplicationSpecialist(ctx,args,{...options,helpers:ctx.submissionAttempted?undefined:options.helpers,reviewEvidence:packet,
  proposedStop:options.proposedStop?redactPrivateAuthenticationData(options.proposedStop,before.secrets):undefined});
 // Re-OBSERVE the existing page. Never reload, reset fields or navigate.
 const after=await capture();ctx.observation=after.observation;
 if(ctx.page!==page||before.id!==after.id){
  return ok('STALE SPECIALIST ADVICE DISCARDED: the current application changed during the recovery review. Its advice was discarded. Reinspect the existing page without reloading it; no browser write or final status was authorized.','reobserve');
 }
 ctx.observation.reviewEvidence=packet;
 return result;
 } finally {reviewing.delete(ctx);}
}
