import {createHash,randomUUID} from 'node:crypto';
import {renderObservation,type Observation} from './observe.js';
import type {ToolSchema} from './celeris.js';
import {toolInputIssue} from './tool-input.js';

interface Operation {name:string;args:Record<string,unknown>}
interface Verification {kind:'field-value'|'visible-text'|'control-enabled'|'url-path';target:string;value:string}
interface RecoveryAttempt { id:string; strategy:string; firstOperation:string; }
interface Task {
  id:string;advice:string;adviceKey:string;phase:'decision'|'action'|'verification'|'resolved'|'blocked';
  decision?:string;reason?:string;plan?:{tool:string;action?:string;purpose:string};operation?:Operation;verification?:Verification;
  before?:string;beforeSatisfied?:boolean;result?:string;failed?:boolean;readOnly?:boolean;
  actionObservation?:number;history:string[];verifiedEvidence:string[];visited:string[];checks:number;invalidChecks?:number;stopReason?:string; attempts?:RecoveryAttempt[]; attemptOpen?:boolean; resultVersion?:number;
}
const text={type:'string',minLength:1,maxLength:2000};
export const specialistVerificationSchema={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['field-value','visible-text','control-enabled','url-path']},target:{...text,description:'Exact field/action label or current ref (without annotations), exact visible text, or URL origin. Use the final blocker goal, not an intermediate navigation step.'},value:{type:'string',maxLength:4000,description:'Exact expected currentValue for a field (no explanatory prose), true/false for enabled controls, exact visible text, or exact URL pathname. Empty string is valid when clearing an unsupported field.'}},required:['kind','target','value']};
export const specialistRecoveryTools:ToolSchema[]=[
 {name:'respond_to_specialist',description:'Optional agent decision: choose a materially different recovery approach or revise the current one. Up to three executed approaches per blocker; planning and reporting do not spend attempts. The main agent may instead continue directly from current evidence, inspect, prepare through the normal accuracy check, request a real missing answer or record a technical error. Specialist advice cannot force a stop.',parameters:{type:'object',additionalProperties:false,properties:{
  advice_id:text,decision:{type:'string',enum:['adopt','alternative','reject']},reason:text,
  evidence_quote:{type:'string',minLength:8,maxLength:2000},observation_id:{type:'string',minLength:1,description:'Use the current observation_id from the recovery record instead of reproducing page text.'},
  operation_tool:{...text,description:'Name of the one offered normal tool to execute next, for example browser_action.'},
  operation_action:{type:'string',minLength:1,maxLength:100,description:'For browser_action only: the normal action, such as inspect, click, fill or scroll. Omit for other tools. The next turn uses that normal tool schema for its actual arguments; do not encode them here.'},
  operation_purpose:{type:'string',minLength:8,maxLength:2000,description:'Concrete intended repair or inspection and its current observed target. The following normal typed tool call supplies and validates the executable arguments once.'},
  verification:specialistVerificationSchema,
 },required:['advice_id','decision','reason','operation_tool','operation_purpose','verification']}},
 {name:'check_specialist_recovery',description:'Optional assessment of the latest actual operation and fresh browser observation. Prefer observation_id and result_id from the recovery record over copying quotations. A reporting error never ends an application. resolved requires the goal to be visible now; progress can wait for delayed rendering; no_progress ends this approach; blocked is the main agent decision to preserve unfinished work. This never approves, saves a draft or submits.',parameters:{type:'object',additionalProperties:false,properties:{
  advice_id:text,assessment:{type:'string',enum:['resolved','progress','no_progress','blocked']},
  result_quote:{type:'string',minLength:8,maxLength:2000},observation_quote:{type:'string',minLength:8,maxLength:2000},observation_id:{type:'string',minLength:1},result_id:{type:'string',minLength:1},reason:text,
 },required:['advice_id','assessment','reason']}},
];
const normal=(value:unknown)=>String(value??'').replace(/\s+/g,' ').trim();
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** Only documented transport defaults are equivalent. Target, value, scope,
 * action and send intent still have to match the committed operation. */
function normalizedOperation(op:Operation):Operation {
 const normalize=(input:Record<string,unknown>)=>{
  const args={...input};
  if(args.target_mode===undefined){const mode=args.locator?'locator':args.selector?'selector':args.ref?'ref':undefined;if(mode)args.target_mode=mode;}
  if(args.locator&&typeof args.locator==='object'&&!Array.isArray(args.locator)){
   const locator={...args.locator as Record<string,unknown>};
   if(['role','label','placeholder','text'].includes(String(locator.by))&&locator.exact===undefined)locator.exact=true;
   if(locator.frame==='')delete locator.frame;
   args.locator=locator;
  }
  return args;
 };
 return {...op,args:op.name==='browser_batch'?{...op.args,actions:Array.isArray(op.args.actions)?op.args.actions.map(action=>normalize(action as Record<string,unknown>)):op.args.actions}
  :['browser_action','take_snapshot'].includes(op.name)?normalize(op.args):op.args};
}
const operationHash=(name:string,args:Record<string,unknown>)=>hash(normalizedOperation({name,args}));
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
export const sameSpecialistObservation=(before:Observation,after:Observation)=>!before.inspectionError&&!after.inspectionError
 &&before.url===after.url&&hash(surface(before))===hash(surface(after));
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
function bindGoal(v:Verification,o?:Observation):Verification {
 if(!v||!o)return v;
 if(v.kind==='field-value'){
  const field=safeFields(o).find(field=>field.ref===v.target);
  if(field)return {...v,target:field.label};
 }
 if(v.kind==='control-enabled'){
  const action=o.actions.find(action=>action.ref===v.target);
  if(action)return {...v,target:action.text};
 }
 return v;
}
const workTools=new Set(['browser_action','browser_batch','take_snapshot','check_employer_account','complete_authentication','enter_emailed_code','open_emailed_link','record_authentication_result','wait_for_verification','render_approved_cover_letter','convert_file','create_file','read_candidate_evidence','read_browser_experience']);
function operationKey(op:Operation,o:Observation):string {
 const args={...normalizedOperation(op).args};
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
 private checkpointGoal?:Verification;
 constructor(saved?:{version:1;task?:Task;observationVersion:number}) {
  if(saved){
   if(saved.version!==1)throw Error('Unsupported specialist recovery checkpoint');
   this.task=saved.task;this.observationVersion=saved.observationVersion;
   if(this.task){
    this.task.attempts??=[];
    // Older records could be blocked by malformed reports rather than failed work.
    if(this.task.phase==='blocked'&&this.task.stopReason?.startsWith('Specialist recovery verification could not be completed:'))this.task.phase='decision';
    // Older checkpoints could store the newest advice alongside its predecessor's
    // goal. Reconcile a same-control correction only after fresh named evidence.
    if(this.task.phase!=='resolved'&&this.task.advice.startsWith('READ-ONLY SPECIALIST ADVICE.')){
     try{
      const goal=JSON.parse(this.task.advice.slice(this.task.advice.indexOf('\n')+1)).recovery_goal as Verification;
      const old=this.task.verification;
      if(!toolInputIssue(goal,specialistVerificationSchema)&&old&&goal.kind===old.kind
       &&normal(goal.target)===normal(old.target)&&hash(goal)!==hash(old))this.checkpointGoal=goal;
     }catch{/* Invalid historical advice cannot change the recorded goal. */}
    }
   }
  }
 }
 checkpoint(){return {version:1 as const,task:this.task,observationVersion:this.observationVersion};}
 observe(o:Observation){
  this.observation=o;
  if(!o.inspectionError){
   this.observationVersion++;
   const goal=this.checkpointGoal;
   const named=goal?.kind==='field-value'?safeFields(o).filter(f=>normal(f.label)===normal(goal.target))
    :goal?.kind==='control-enabled'?o.actions.filter(a=>normal(a.text)===normal(goal.target)):[];
   if(goal&&named.length===1){this.checkpointGoal=undefined;this.reviseGoal(goal);}
  }
 }
 private reviseGoal(goal:Verification):void {
  const t=this.task!;
  // Invalidate reports based on the previous advice without minting more work
  // attempts or discarding actual operations, results and duplicate protection.
  t.id=randomUUID();t.verification=goal;t.phase='decision';t.attemptOpen=false;t.invalidChecks=0;
  delete t.decision;delete t.reason;delete t.plan;delete t.stopReason;
 }
 private get observationId(){return this.observation?`observation:${this.observationVersion}:${hash(surface(this.observation)).slice(0,16)}`:undefined;}
 private get resultId(){return this.task?.result!==undefined?`result:${this.task.id}:${this.task.resultVersion??0}`:undefined;}
 private get goalObserved(){return !!this.task?.verification&&!!this.observation&&satisfies(this.task.verification,this.observation);}
 accept(advice:string):void {
  if(!advice.startsWith('READ-ONLY SPECIALIST ADVICE.'))return;
  const header=advice.slice(0,advice.indexOf('\n')),contents=JSON.parse(advice.slice(advice.indexOf('\n')+1));
  const goal=bindGoal(contents.recovery_goal as Verification,this.observation);
  const issue=toolInputIssue(goal,specialistVerificationSchema);if(issue)throw Error('Specialist advice lacks a verifiable recovery goal: '+issue);
  const adviceKey=hash([advice,this.observation?surface(this.observation):'']);
  const goalChanged=!!this.task&&(!this.task.verification||hash(this.task.verification)!==hash(goal));
  if(this.task?.adviceKey===adviceKey&&!goalChanged)return;
  this.checkpointGoal=undefined;
  const boundAdvice=header+'\n'+JSON.stringify({...contents,recovery_goal:goal});
  // Another consultation cannot reset this blocker's spent attempts.
  if(this.pending){
   this.task!.advice=boundAdvice;this.task!.adviceKey=adviceKey;
   if(goalChanged)this.reviseGoal(goal);
   return;
  }
  this.task={id:randomUUID(),advice:boundAdvice,adviceKey,phase:'decision',verification:goal,history:[],verifiedEvidence:[],visited:this.observation?[hash(surface(this.observation))]:[],checks:0,attempts:[]};
 }
 get pending(){return !!this.task&&this.task.phase!=='resolved'&&!this.goalObserved;}
 get unresolved(){return this.pending;}
 get blocked(){return this.task?.phase==='blocked';}
 get consulted(){return !!this.task?.advice.startsWith('READ-ONLY SPECIALIST ADVICE.');}
 // Kept for checkpoint compatibility. Advice never chooses the next tool.
 get requiredTool():string|undefined {return undefined;}
 get exhausted(){return this.pending&&!this.task?.attemptOpen&&(this.task?.attempts?.length??0)>=3;}
 render():string {
  if(!this.task)return '';
  const {id,phase,decision,reason,plan,operation,verification,result,failed,stopReason,attempts}=this.task;
  return `SPECIALIST RECOVERY OBLIGATION\n${JSON.stringify({advice_id:id,phase,decision,reason,plan,operation,verification,result,failed,stopReason,attempts:attempts?.length??0,max_attempts:3,goal_observed:this.goalObserved,observation_id:this.observationId,result_id:this.resultId})}\n${this.task.advice.slice(0,6000)}\nCurrent observation evidence for exact quotations: ${this.observation?surface(this.observation).slice(0,8000):'not yet available'}.\nAGENT-LED RECOVERY: You alone decide the next action. Advice and reports never save a draft, prove a send or force a skip. Continue directly when current evidence permits it; prepare through the canonical accuracy review even if a report was rejected. Use the evidence IDs above when assessing recovery, rather than reproducing page text. Up to three genuinely different executed approaches per blocker; reports, inspections and loading waits do not consume attempts. After an unsuccessful approach choose a different one; do not repeat an unchanged failed interaction. If the limit is reached, inspect for delayed success, prepare if actually complete, ask only a real missing employer question, or finish with status=error to preserve a retryable technical checkpoint. Never invent candidate facts or repeat an uncertain application send. Existing approval, receipt, time and cost controls still apply.`;
 }
 private checkObservation(args:Record<string,unknown>):void {
  if(!this.observation||this.observation.inspectionError)throw Error('Inspect the current browser state first. No application outcome was changed.');
  if(args.observation_id!==undefined){if(args.observation_id!==this.observationId)throw Error('That observation ID is stale. Use the current observation_id; no browser action or stop was executed.');}
  else if(!args.evidence_quote&&!args.observation_quote||!evidence(this.observation).includes(normal(args.evidence_quote??args.observation_quote)))throw Error('Reference the current observation_id or quote current observed evidence exactly. This is reporting feedback, not a failed recovery attempt.');
 }
 respond(args:Record<string,unknown>,tools:ToolSchema[]):string {
  const t=this.task,o=this.observation;
  if(!t||args.advice_id!==t.id||!o)throw Error('This recovery decision is stale. Inspect the current record.');
  this.checkObservation(args);
  const name=String(args.operation_tool),tool=tools.find(s=>s.name===name);
  if(!(workTools.has(name)||name.startsWith('helper_'))||!tool)throw Error('Choose one offered recovery tool. Preparation and final decisions use their own normal tools.');
  const action=name==='browser_action'&&typeof args.operation_action==='string'?args.operation_action:undefined;
  if(name==='browser_action'){
   const allowed=(tool.parameters.properties as Record<string,{enum?:unknown[]}>)?.action?.enum;
   if(action&&(allowed&&!allowed.includes(action)||['script','dialog'].includes(action)))throw Error('Choose a supported native browser action for recovery; no scripts or dialog acceptance');
  }
  const verification=bindGoal(args.verification as unknown as Verification,o);
  const issue=toolInputIssue(verification,specialistVerificationSchema);if(issue)throw Error('Choose a verifiable recovery goal: '+issue);
  const sameGoal=t.verification&&hash(t.verification)===hash(verification);
  if(t.verification&&!sameGoal&&args.decision==='adopt')throw Error('Keep the original recovery goal, or choose an evidence-based alternative. No stop was recorded.');
  if(this.exhausted)throw Error('Three recovery approaches have already executed for this blocker. Read-only investigation, canonical preparation and truthful final decisions remain available. No fourth repair was started.');
  // A new decision closes the previous approach, but spends nothing until work executes.
  t.attemptOpen=false;t.decision=String(args.decision);t.reason=String(args.reason);
  t.plan={tool:name,...(action?{action}:{}),purpose:String(args.operation_purpose)};
  t.verification=verification;t.phase='action';t.invalidChecks=0;
  return 'Recovery approach recorded; nothing executed. Choose its normal tool actions, inspect delayed results, or proceed directly to validated preparation. No reporting checkpoint is mandatory.';
 }
 permit(name:string,args:Record<string,unknown>,_completionOnly=false,_receiptRecorded=false):string|undefined {
  const t=this.task,o=this.observation;
  if(!t)return;
  // Final classifications, canonical preparation, missing-answer capture and reads
  // keep their own existing validation. An advisory never removes those tools.
  if(!this.pending||!this.mutating(name,args))return;
  if(o?.inspectionError)return 'Not executed: re-inspect the browser before another recovery mutation. No application outcome was changed.';
  const op=normalizedOperation({name,args}),key=o?operationKey(op,o):operationHash(name,args);
  if(t.history.includes(key))return 'Not executed: this exact interaction already ran in the same observed state. Inspect its actual result or choose a materially different approach; no retry or skip was recorded.';
  if(this.exhausted)return 'Not executed: three distinct recovery approaches have been used for this blocker. Inspect or wait for delayed evidence, prepare through normal validation if complete, ask a genuinely missing candidate fact, or finish with status=error to preserve retryable technical work. No skip was forced.';
  t.operation=op;t.before=o?hash(surface(o)):undefined;t.actionObservation=this.observationVersion;t.readOnly=false;
 }
 private mutating(name:string,args:Record<string,unknown>):boolean {
  // Sending is governed by the independent canonical approval/receipt boundary,
  // never by a specialist decision or this repair counter.
  if(args.sends_application===true)return false;
  if(name==='browser_batch')return Array.isArray(args.actions)&&args.actions.some(action=>this.mutating('browser_action',action as Record<string,unknown>));
  if(name==='browser_action')return !['inspect','wait','take_snapshot','scroll','hover','select_page'].includes(String(args.action))&&args.script_intent!=='inspect';
  return ['complete_authentication','enter_emailed_code','open_emailed_link','wait_for_verification'].includes(name)||name.startsWith('helper_');
 }
 complete(name:string,args:Record<string,unknown>,result:string,failed:boolean,executed=true):void {
  const o=this.observation;
  if(['respond_to_specialist','check_specialist_recovery','finish','prepare_application','prepare_email_application','record_application_review'].includes(name))return;
  const op=normalizedOperation({name,args});
  const isWrite=this.mutating(name,args);
  // A blocker can arise before any consultation. Record the failed original
  // operation, then bound its recoveries; do not wait for a second model.
  if((!this.task||!this.pending)&&isWrite&&executed&&failed){
   this.task={id:randomUUID(),advice:'An actual native operation failed. The applying agent chooses a recovery goal and up to three different approaches; optional specialist advice cannot choose the outcome.',adviceKey:hash([name,args,result]),phase:'decision',history:[o?operationKey(op,o):operationHash(name,args)],verifiedEvidence:[],visited:[],checks:0,attempts:[],result,resultVersion:1,failed:true,operation:op,actionObservation:this.observationVersion};
   return;
  }
  const t=this.task;
  if(!t||!this.pending)return;
  if(isWrite&&executed){
   const key=o?operationKey(op,o):operationHash(name,args);
   if(!t.attemptOpen){
    if((t.attempts?.length??0)>=3)throw Error('Recovery attempt accounting exceeded its permitted limit.');
    (t.attempts??=[]).push({id:randomUUID(),strategy:t.plan?.purpose??`${name}:${String(args.action??'')}`,firstOperation:key});t.attemptOpen=true;
   }
   t.history.push(key);
  }
  t.operation=op;t.result=result;t.failed=failed;t.readOnly=!isWrite;
  t.resultVersion=(t.resultVersion??0)+1;t.actionObservation=this.observationVersion;t.phase='verification';
  if(isWrite&&executed&&failed){t.attemptOpen=false;t.phase='decision';delete t.plan;}
 }
 failedCheck(name:string,reason:string):void {
  if(!this.task||!['respond_to_specialist','check_specialist_recovery'].includes(name))return;
  this.task.invalidChecks=(this.task.invalidChecks??0)+1;
  this.task.stopReason='Reporting feedback only; no attempt or outcome changed: '+reason;
 }
 reconsider():void {if(this.task){this.task.phase='decision';this.task.attemptOpen=false;}}
 applicationReviewed():void {if(this.task){this.task.phase='resolved';this.task.attemptOpen=false;}}
 check(args:Record<string,unknown>):string {
  const t=this.task,o=this.observation;
  if(!t||args.advice_id!==t.id||!o||o.inspectionError||t.result===undefined||this.observationVersion<=(t.actionObservation??Infinity))throw Error('Assess the actual operation after a fresh successful observation. No stop was recorded.');
  this.checkObservation(args);
  if(args.result_id!==undefined){if(args.result_id!==this.resultId)throw Error('That result ID is stale. Use the current result_id; no recovery attempt or outcome changed.');}
  else if(!args.result_quote||!resultMaterial(t.result).includes(normal(args.result_quote)))throw Error('Reference the actual result_id or quote its tool result exactly. This is reporting feedback, not a failed recovery attempt.');
  const verified=this.goalObserved,changed=t.before!==hash(surface(o));t.checks++;
  if(args.assessment==='resolved'&&!verified)throw Error('The recovery goal is not yet observed. Continue, wait or inspect; do not claim readiness from narration. No stop was recorded.');
  if(args.assessment==='resolved'){t.phase='resolved';t.attemptOpen=false;return 'The recovery goal is observed now. Choose the normal next action; preparation, approval and receipt checks still apply.';}
  if(args.assessment==='blocked'||args.assessment==='no_progress'){t.phase=args.assessment==='blocked'?'blocked':'decision';t.attemptOpen=false;t.stopReason=String(args.reason);delete t.plan;}
  return `Agent recovery assessment recorded: ${String(args.assessment)}. Browser state changed: ${changed}; goal currently observed: ${verified}. Reporting is optional. Wait/reinspect delayed rendering, choose a different approach within the remaining ${Math.max(0,3-(t.attempts?.length??0))}, prepare through normal validation, ask a real missing fact, or record a retryable technical error. No final application status was chosen by this assessment.`;
 }
}
