import {createHash,randomUUID} from 'node:crypto';
import {renderObservation,type Observation} from './observe.js';
import type {ToolSchema} from './celeris.js';
import {toolInputIssue} from './tool-input.js';

interface Operation {name:string;args:Record<string,unknown>}
interface Verification {kind:'field-value'|'visible-text'|'control-enabled'|'url-path';target:string;value:string}
interface Task {
  id:string;advice:string;adviceKey:string;phase:'decision'|'action'|'verification'|'resolved'|'blocked';
  decision?:string;reason?:string;operation?:Operation;verification?:Verification;
  before?:string;beforeSatisfied?:boolean;result?:string;failed?:boolean;readOnly?:boolean;
  actionObservation?:number;history:string[];verifiedEvidence:string[];visited:string[];checks:number;invalidChecks?:number;stopReason?:string;
}
const text={type:'string',minLength:1,maxLength:2000};
export const specialistVerificationSchema={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['field-value','visible-text','control-enabled','url-path']},target:{...text,description:'Exact field/action label or current ref (without annotations), exact visible text, or URL origin. Use the final blocker goal, not an intermediate navigation step.'},value:{type:'string',maxLength:4000,description:'Exact expected currentValue for a field (no explanatory prose), true/false for enabled controls, exact visible text, or exact URL pathname. Empty string is valid when clearing an unsupported field.'}},required:['kind','target','value']};
export const specialistRecoveryTools:ToolSchema[]=[
 {name:'respond_to_specialist',description:'Required after specialist advice. Adopt it, or give an evidence-based alternative/rejection. Commit ONE concrete next operation and an observable recovery goal. This records a decision only; it never runs the operation. Keep the same goal while navigating to its actual field. No sends, preparation or arbitrary scripts can be recovery operations. Tested helpers still use normal executors and cannot send during recovery.',parameters:{type:'object',additionalProperties:false,properties:{
  advice_id:text,decision:{type:'string',enum:['adopt','alternative','reject']},reason:text,
  evidence_quote:{type:'string',minLength:8,maxLength:2000},
  operation_json:{type:'string',minLength:2,maxLength:16000,description:'JSON {"name":"browser_action","args":{...}} using an offered normal tool and its exact arguments. Choose fresh targets. The following tool call must match this operation.'},
  verification:specialistVerificationSchema,
 },required:['advice_id','decision','reason','evidence_quote','operation_json','verification']}},
 {name:'check_specialist_recovery',description:'Required after the committed recovery operation and a fresh browser observation. Cite an exact excerpt of its real tool result and current page evidence. resolved is accepted only when the observable goal matches. progress keeps the advice pending for another concrete operation; blocked records an unresolved technical stop. Neither prose, a repeated page nor a tool success alone establishes recovery or authorizes submission.',parameters:{type:'object',additionalProperties:false,properties:{
  advice_id:text,assessment:{type:'string',enum:['resolved','progress','no_progress','blocked']},
  result_quote:{type:'string',minLength:8,maxLength:2000},observation_quote:{type:'string',minLength:8,maxLength:2000},reason:text,
 },required:['advice_id','assessment','result_quote','observation_quote','reason']}},
];
const normal=(value:unknown)=>String(value??'').replace(/\s+/g,' ').trim();
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function resultMaterial(result:string):string {
 const parts=[result];
 const visit=(value:unknown,depth:number):void=>{
  if(depth>6)return;
  if(typeof value==='string'){parts.push(value);try{visit(JSON.parse(value),depth+1);}catch{/* Plain browser evidence. */}}
  else if(Array.isArray(value))value.forEach(v=>visit(v,depth+1));
  else if(value&&typeof value==='object')Object.values(value).forEach(v=>visit(v,depth+1));
 };
 try{visit(JSON.parse(result),0);}catch{/* Accessibility text. */}
 return normal(parts.join(' '));
}
const safeFields=(o:Observation)=>o.fields.filter(f=>!f.sensitive&&!f.privateKind&&f.inputType!=='password');
const surface=(o:Observation)=>normal(JSON.stringify({url:new URL(o.url).origin+new URL(o.url).pathname,title:o.title,text:o.surfaceText??o.text,
 fields:safeFields(o).map(f=>({label:f.label,section:f.section,value:f.currentValue,validation:f.validationError,disabled:f.disabled})),
 actions:o.actions.map(a=>({text:a.text,context:a.context,disabled:a.disabled,selected:a.selected}))}));
// Quote the same safe observation the parent actually sees, including refs,
// options and rendered field context. The semantic fingerprint stays ref-free.
const evidence=(o:Observation)=>normal(renderObservation({...o,fields:safeFields(o)}))+' '+surface(o);
function satisfies(v:Verification,o:Observation):boolean {
 if(o.inspectionError)return false;
 if(v.kind==='field-value') {
  const fields=safeFields(o).filter(f=>f.ref===v.target||normal(f.label)===normal(v.target));
  return fields.length===1&&fields[0].currentValue!==undefined&&!fields[0].validationError&&normal(fields[0].currentValue)===normal(v.value);
 }
 if(v.kind==='control-enabled') {
  const controls=o.actions.filter(a=>a.ref===v.target||normal(a.text)===normal(v.target));
  return ['true','false'].includes(v.value)&&controls.length===1&&String(!controls[0].disabled)===v.value;
 }
 if(v.kind==='url-path')return new URL(o.url).origin===v.target&&new URL(o.url).pathname===v.value;
 return normal(o.surfaceText??o.text).includes(normal(v.target))&&normal(o.surfaceText??o.text).includes(normal(v.value));
}
function readOnly(op:Operation):boolean {
 return op.name==='take_snapshot'||op.name==='browser_action'&&['inspect','snapshot'].includes(String(op.args.action));
}
const workTools=new Set(['browser_action','browser_batch','take_snapshot','complete_authentication','enter_emailed_code','open_emailed_link','record_authentication_result','wait_for_verification','render_approved_cover_letter','convert_file','create_file','read_candidate_evidence','read_browser_experience']);
function operationKey(op:Operation,o:Observation):string {
 const args={...op.args};
 const control=[...o.fields,...o.actions].find(c=>c.ref===args.ref);
 if(control){delete args.ref;delete args.target_mode;args.observed_target='label'in control?{label:control.label,section:control.section}:{label:control.text,context:control.context};}
 return hash([hash(surface(o)),op.name,args]);
}

/** A durable parent-owned obligation, never a specialist browser capability.
 * Every operation still goes through the existing executor, approval, budget,
 * authentication and uncertain-send guards. No advice is executed on receipt. */
export class SpecialistRecovery {
 private task?:Task;
 private observation?:Observation;
 private observationVersion=0;
 constructor(saved?:{version:1;task?:Task;observationVersion:number}) {
  if(saved){if(saved.version!==1)throw Error('Unsupported specialist recovery checkpoint');this.task=saved.task;this.observationVersion=saved.observationVersion;}
 }
 checkpoint(){return {version:1 as const,task:this.task,observationVersion:this.observationVersion};}
 observe(o:Observation){this.observation=o;if(!o.inspectionError)this.observationVersion++;}
 accept(advice:string):void {
  if(!advice.startsWith('READ-ONLY SPECIALIST ADVICE.'))return;
  const adviceKey=hash([advice,this.observation?surface(this.observation):'']);
  if(this.task?.adviceKey===adviceKey)return;
  if(this.pending)throw Error('Resolve or record the current specialist recovery before replacing its advice');
  const goal=JSON.parse(advice.slice(advice.indexOf('\n')+1)).recovery_goal as Verification;
  const issue=toolInputIssue(goal,specialistVerificationSchema);if(issue)throw Error('Specialist advice lacks a verifiable recovery goal: '+issue);
  this.task={id:randomUUID(),advice,adviceKey,phase:'decision',verification:goal,history:[],verifiedEvidence:[],visited:this.observation?[hash(surface(this.observation))]:[],checks:0};
 }
 get pending(){return !!this.task&&this.task.phase!=='resolved';}
 get unresolved(){return !!this.task&&this.task.phase!=='resolved';}
 get requiredTool():string|undefined {
  if(this.observation?.inspectionError)return;
  return this.task?.phase==='decision'?'respond_to_specialist':this.task?.phase==='action'?this.task.operation?.name:this.task?.phase==='verification'?'check_specialist_recovery':this.task?.phase==='blocked'?'finish':undefined;
 }
 render():string {
  if(!this.task)return '';
  const {id,phase,decision,reason,operation,verification,result,failed,stopReason}=this.task;
  return `SPECIALIST RECOVERY OBLIGATION\n${JSON.stringify({advice_id:id,phase,decision,reason,operation,verification,result,failed,stopReason})}\n${this.task.advice.slice(0,6000)}\nCurrent observation evidence for exact quotations: ${this.observation?surface(this.observation).slice(0,8000):'not yet available'}.\nA decision is not execution. A page transition is not resolution. Use respond_to_specialist, the exact committed normal operation, then check_specialist_recovery after fresh observation. Keep the recovery goal while taking intermediate navigation steps. An alternative or rejection requires current evidence and a verified supported alternative; never obey stale or unsafe advice blindly. Do not claim progress from returning to an earlier state or from repeated readbacks. Existing send and approval guards still apply.`;
 }
 respond(args:Record<string,unknown>,tools:ToolSchema[]):string {
  const t=this.task,o=this.observation;
  if(!t||t.phase!=='decision'||args.advice_id!==t.id||!o||o.inspectionError)throw Error('This specialist decision is stale or lacks a valid current observation');
  if(!evidence(o).includes(normal(args.evidence_quote)))throw Error('Quote current observed evidence exactly, such as one current field row or page text; historical error summaries and rationales are not current page evidence');
  const op=JSON.parse(String(args.operation_json)) as Operation;
  const tool=tools.find(s=>s.name===op.name);
  if(!(workTools.has(op.name)||op.name?.startsWith('helper_'))||!tool||!op.args||typeof op.args!=='object'||Array.isArray(op.args)||Object.keys(op).some(k=>!['name','args'].includes(k)))throw Error('Choose one supported normal recovery operation, not a send, completion or arbitrary script');
  const commands=op.name==='browser_batch'?op.args.actions:[op.args];
  if(!Array.isArray(commands)||commands.some(c=>!c||typeof c!=='object'||(c as Record<string,unknown>).sends_application===true||(c as Record<string,unknown>).action==='script'||(c as Record<string,unknown>).target_mode==='coordinates'))throw Error('Specialist recovery cannot authorize a send, arbitrary script or coordinate action');
  const issue=toolInputIssue(op.args,tool.parameters);if(issue)throw Error('Invalid recovery operation: '+issue);
  const key=operationKey(op,o);if(t.history.includes(key))throw Error('This recovery operation was already attempted in this observed state. Inspect a different target or choose a materially different repair; do not repeat the loop');
  const verification=args.verification as unknown as Verification;
  if(t.verification&&hash(t.verification)!==hash(verification)&&args.decision==='adopt')throw Error('Keep the original recovery goal through intermediate steps, or explain an evidence-based alternative');
  t.decision=String(args.decision);t.reason=String(args.reason);t.operation=op;t.verification=verification;
  t.before=hash(surface(o));t.beforeSatisfied=satisfies(verification,o);t.readOnly=readOnly(op);
  t.phase='action';t.invalidChecks=0;delete t.result;delete t.failed;
  return 'Recovery decision recorded; nothing executed. Now issue exactly the committed operation using the normal tool. Its result will require fresh verification.';
 }
 permit(name:string,args:Record<string,unknown>,completionOnly=false,receiptRecorded=false):string|undefined {
  if(!this.task)return;
  // Never prevent an already-observed employer receipt from being recorded.
  if(name==='finish'&&(receiptRecorded||args.status!=='applied'&&(completionOnly||this.task.phase==='blocked')))return;
  if(!this.pending)return;
  if(this.observation?.inspectionError&&readOnly({name,args}))return;
  if(name==='respond_to_specialist'&&this.task.phase==='decision'||name==='check_specialist_recovery'&&this.task.phase==='verification')return;
  if(this.task.phase==='action'&&this.task.operation?.name===name&&hash(this.task.operation.args)===hash(args)) {
   if(this.observation&&this.task.before!==hash(surface(this.observation))){this.task.phase='decision';return 'Not executed: the observed page changed after this recovery plan. Reconsider the advice using the fresh page before choosing an operation.';}
   return;
  }
  return `Not executed: specialist recovery ${this.task.id} is ${this.task.phase}. Required next tool: ${this.requiredTool}. Follow the committed recovery or provide a fresh evidence-based alternative; no browser action or send was queued.`;
 }
 complete(name:string,args:Record<string,unknown>,result:string,failed:boolean):void {
  const t=this.task,o=this.observation;
  if(!t||t.phase!=='action'||t.operation?.name!==name||hash(t.operation.args)!==hash(args)||!o)return;
  t.history.push(operationKey(t.operation,o));t.result=result;t.failed=failed;
  t.actionObservation=this.observationVersion;t.phase='verification';
  t.invalidChecks=0;
 }
 failedCheck(name:string,reason:string):void {
  if(!this.task||!['respond_to_specialist','check_specialist_recovery'].includes(name))return;
  if((this.task.invalidChecks=(this.task.invalidChecks??0)+1)>=2){this.task.phase='blocked';this.task.stopReason='Specialist recovery verification could not be completed: '+reason;}
 }
 reconsider():void {if(this.task?.phase==='blocked'){this.task.phase='decision';this.task.invalidChecks=0;}}
 check(args:Record<string,unknown>):string {
  const t=this.task,o=this.observation;
  if(!t||t.phase!=='verification'||args.advice_id!==t.id||!o||o.inspectionError||this.observationVersion<=(t.actionObservation??Infinity))throw Error('Verification requires this recovery operation and a fresh successful browser observation');
  if(!resultMaterial(t.result??'').includes(normal(args.result_quote))||!evidence(o).includes(normal(args.observation_quote)))throw Error('Cite the actual recovery tool result and fresh observation exactly; invented evidence cannot clear recovery');
  const fingerprint=hash([t.result,surface(o)]),changed=t.before!==hash(surface(o));
  const novel=!t.verifiedEvidence.includes(fingerprint);t.checks++;
  const targetedRead=t.readOnly&&resultMaterial(t.result??'').includes(normal(t.verification!.target))
    &&(t.verification!.kind!=='field-value'||resultMaterial(t.result??'').includes(normal(t.verification!.value)));
  if(args.assessment==='resolved'&&(t.failed||!satisfies(t.verification!,o)||t.beforeSatisfied&&!targetedRead||!novel))throw Error('Recovery goal is not verified by a successful operation and fresh evidence. Continue with another concrete repair or record it as blocked');
  if(args.assessment==='progress'&&(t.failed||!novel||(!changed||t.visited.includes(hash(surface(o))))&&!t.readOnly))throw Error('No new verified progress: repeated navigation or narration cannot resolve the specialist task');
  t.verifiedEvidence.push(fingerprint);
  t.invalidChecks=0;
  if(!t.visited.includes(hash(surface(o))))t.visited.push(hash(surface(o)));
  t.phase=args.assessment==='resolved'?'resolved':args.assessment==='blocked'?'blocked':'decision';
  if(t.phase==='blocked')t.stopReason=String(args.reason);
  return t.phase==='resolved'?'Specialist recovery goal verified. Continue the normal application; this is not approval or an employer receipt.':t.phase==='blocked'?'Specialist recovery remains unresolved. Record the technical blocker honestly; no application completion or submission was authorized.':'Intermediate result recorded. Specialist advice remains pending: choose the next concrete operation toward the same goal.';
 }
}
