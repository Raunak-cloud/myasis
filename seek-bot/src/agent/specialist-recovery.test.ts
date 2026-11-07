import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SpecialistRecovery} from './specialist-recovery.js';
import type {Observation} from './observe.js';
import type {ToolSchema} from './celeris.js';
const tools=[{name:'browser_action',description:'Native browser tool',parameters:{type:'object',properties:{action:{enum:['click','fill','press','inspect','wait']}}}}] as ToolSchema[];
const obs=(text='Verification pending',value=''):Observation=>({url:'https://fixture.invalid/form',title:'Application',text,fields:[{ref:'f0',label:'Answer',kind:'text',required:true,currentValue:value}],actions:[{ref:'a0',text:'Continue',role:'button',disabled:false}]});
const goal={kind:'field-value',target:'Answer',value:'Known candidate answer'};
const view=(r:SpecialistRecovery)=>JSON.parse(r.render().match(/SPECIALIST RECOVERY OBLIGATION\n([^\n]+)/)![1]);
function start(){const r=new SpecialistRecovery();r.observe(obs());r.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Inspect and fix the actual blocker.',recovery_goal:goal}));return r;}
function plan(r:SpecialistRecovery,action='click',purpose='Use a different observed native approach'){
 return {advice_id:view(r).advice_id,decision:'adopt',reason:'Current evidence identifies the unresolved field.',observation_id:view(r).observation_id,operation_tool:'browser_action',operation_action:action,operation_purpose:purpose,verification:goal};
}
function act(r:SpecialistRecovery,args:Record<string,unknown>,failed=false,executed=true){assert.equal(r.permit('browser_action',args),undefined);r.complete('browser_action',args,'Actual native operation result',failed,executed);r.observe(obs());}
function check(r:SpecialistRecovery,assessment='progress'){const v=view(r);return {advice_id:v.advice_id,observation_id:v.observation_id,result_id:v.result_id,assessment,reason:'Assess fresh actual browser state.'};}

test('required-marker aliases resolve the completed school blocker and cannot block a different field after view changes or restart',()=>{
 const school=(value=''):Observation=>({...obs(),fields:[{ref:'f7',label:'School*',kind:'text',required:true,currentValue:value,autocomplete:true,selectionState:value?'selected':'empty',searchValue:''}]});
 const r=new SpecialistRecovery();r.observe(school());
 r.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Choose the observed Other fallback.',recovery_goal:{kind:'field-value',target:'School *',value:'Other'}}));
 assert.equal(view(r).verification.target,'School*','bind the AX caption to the unique canonical field');
 for(const args of [{action:'click',ref:'f7'},{action:'fill',ref:'f7',value:'Other'},{action:'press',ref:'f7',value:'Enter'}]){
  assert.equal(r.permit('browser_action',args),undefined);r.complete('browser_action',args,'Actual failed attempt',true,true);r.observe(school());
 }
 assert.equal(r.exhausted,true);
 r.observe(school('Other'));assert.equal(r.pending,false);assert.equal(view(r).phase,'resolved');
 const degree={...obs(),fields:[{ref:'f8',label:'Degree*',kind:'text' as const,required:true,currentValue:''}]};
 r.observe(degree);assert.equal(r.pending,false,'opening Degree cannot resurrect the completed School budget');
 assert.equal(r.permit('browser_action',{action:'select',ref:'f8',value:"Master's Degree"}),undefined);
 assert.match(r.check(check(r,'no_progress')),/remains resolved/,'an obsolete report cannot reopen the old blocker');
 r.reconsider();assert.equal(r.pending,false);
 const restored=new SpecialistRecovery(structuredClone(r.checkpoint()));restored.observe(degree);assert.equal(restored.pending,false);
 restored.complete('browser_action',{action:'select',ref:'f8',value:'Unsupported degree'},'No such option',true,true);
 assert.equal(view(restored).attempts,0,'a new actual Degree failure receives its own recovery scope');
});

test('required-marker normalization never treats two different school controls as one',()=>{
 const r=new SpecialistRecovery();r.observe({...obs(),fields:[{ref:'f1',label:'School*',kind:'text',required:true,currentValue:'Other'},{ref:'f2',label:'School *',kind:'text',required:true,currentValue:''}]});
 r.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Inspect the correct school entry.',recovery_goal:{kind:'field-value',target:'School *',value:'Other'}}));
 assert.equal(r.pending,true,'ambiguous repeated entries still require a unique target');
});

test('a city query is not a dropdown answer; a valid committed full label resolves mechanical recovery without requiring the query text',()=>{
 const city=(selected=false,invalid=false):Observation=>({...obs(),fields:[{ref:'f6',label:'Location (City) *',kind:'text',required:true,autocomplete:true,currentValue:selected?'Sydney, New South Wales, Australia':'',searchValue:selected?'':'Sydney',selectionState:selected?'selected':'searching',...(invalid?{validationError:'Location is required.'}:{})}]});
 const r=new SpecialistRecovery();r.observe(city());
 r.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Select the supported Sydney option, then check its accuracy in the pre-send review.',recovery_goal:{kind:'field-value',target:'Location (City) *',value:'Sydney'}}));
 assert.equal(view(r).verification.kind,'field-selection');assert.equal(r.pending,true,'query text alone cannot resolve the repair');
 for(const args of [{action:'click',ref:'f6'},{action:'fill',ref:'f6',value:'Sydney'},{action:'press',ref:'f6',value:'Enter'}]){
  r.complete('browser_action',args,'Failed query approach',true,true);r.observe(city());
 }
 assert.equal(r.exhausted,true);
 const legacy=structuredClone(r.checkpoint());legacy.task!.verification={kind:'field-value',target:'Location (City) *',value:'Sydney'};
 const restored=new SpecialistRecovery(legacy);restored.observe(city(true,true));assert.equal(restored.pending,true,'employer validation remains authoritative');
 restored.observe(city(true));assert.equal(restored.pending,false);assert.equal(view(restored).phase,'resolved');assert.equal(view(restored).attempts,3,'migration closes verified work without granting additional repair attempts');
 assert.equal(restored.permit('browser_action',{action:'click',ref:'degree'}),undefined,'the completed City scope cannot block the next dropdown');
 assert.match(restored.render(),/field-selection/);
});

test('Sony sequence: unchanged checkbox, malformed reports and delayed review never force a skip',()=>{
 const r=start();r.respond(plan(r),tools);act(r,{action:'click',ref:'a0'});
 assert.match(r.check(check(r)),/goal currently observed: false/,'unchanged DOM can still wait for a visual/async transition');
 for(let n=0;n<2;n++){assert.throws(()=>r.check({...check(r),observation_id:undefined,observation_quote:'TITLE: Review ... PAGE TEXT: Preparing review'}),/current observation_id/);r.failedCheck('check_specialist_recovery','bad copied quotation');}
 assert.equal(r.requiredTool,undefined);assert.equal(view(r).attempts,1);assert.equal(r.blocked,false);
 assert.equal(r.permit('browser_action',{action:'wait'}),undefined);
 r.observe(obs('Review the contents of this job application',goal.value));
 assert.equal(r.permit('prepare_application',{}),undefined);assert.equal(r.permit('record_application_review',{}),undefined);
 assert.equal(r.permit('finish',{status:'error'}),undefined);assert.equal(r.permit('finish',{status:'needs-human'}),undefined,'actual question capture remains owned by the normal finish executor');
 r.applicationReviewed();assert.equal(r.pending,false);
});

test('three actually executed different failed approaches survive restart; a fourth cannot mutate',()=>{
 let r=start();
 for(const [index,args]of [{action:'click',ref:'a0'},{action:'fill',ref:'f0',value:'candidate-supported value'},{action:'press',ref:'f0',value:'ArrowDown'}].entries()){
  r.respond(plan(r,String(args.action),`Approach ${index+1}`),tools);act(r,args,true);assert.equal(view(r).attempts,index+1);
  r=new SpecialistRecovery(structuredClone(r.checkpoint()));r.observe(obs());
 }
 assert.match(r.permit('browser_action',{action:'press',ref:'f0',value:'Enter'})!,/three distinct/);
 assert.equal(r.requiredTool,undefined);assert.equal(r.permit('take_snapshot',{}),undefined);assert.equal(r.permit('browser_action',{action:'wait'}),undefined);
 assert.equal(r.permit('prepare_application',{}),undefined);assert.equal(r.permit('finish',{status:'error'}),undefined);
 r.observe(obs('Delayed successful form readback',goal.value));assert.equal(r.permit('browser_action',{action:'click',ref:'a0'}),undefined,'a delayed verified goal releases the repair-only limit; normal approval guards still apply');
});

test('reports, rejected arguments, reads and waits do not consume approaches',()=>{
 const r=start();for(let n=0;n<4;n++)r.failedCheck('respond_to_specialist','invalid argument');assert.equal(view(r).attempts,0);
 act(r,{action:'inspect',ref:'f0'});act(r,{action:'wait'});assert.equal(view(r).attempts,0);
 r.respond(plan(r),tools);act(r,{action:'click',ref:'a0'},true,false);assert.equal(view(r).attempts,0,'nothing reached the browser');
 act(r,{action:'fill',ref:'f0',value:'supported value'});r.observe(obs('Next wizard page'));
 act(r,{action:'press',ref:'f0',value:'Tab'});assert.equal(view(r).attempts,1,'multiple successful steps belong to the same approach');
});

test('renaming a report or refreshing refs cannot repeat the same failed interaction',()=>{
 const r=start();act(r,{action:'click',ref:'a0'},true);
 r.observe({...obs(),actions:[{ref:'a99',text:'Continue',role:'button',disabled:false}]});
 r.respond(plan(r,'click','Different wording for the same click'),tools);
 assert.match(r.permit('browser_action',{action:'click',ref:'a99'})!,/exact interaction already ran/);assert.equal(view(r).attempts,1);
 r.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'A second consultation does not reset attempts.',recovery_goal:goal}));assert.equal(view(r).attempts,1);
});

test('canonical evidence IDs are fresh, cannot forge success and never authorize submission',()=>{
 const r=start();const stale=view(r).observation_id;r.observe(obs());assert.throws(()=>r.respond({...plan(r),observation_id:stale},tools),/stale/);
 act(r,{action:'inspect',ref:'f0'});assert.throws(()=>r.check({...check(r),result_id:'invented'}),/stale/);
 assert.throws(()=>r.check(check(r,'resolved')),/not yet observed/);assert.equal(r.blocked,false);assert.equal(view(r).attempts,0);
 r.observe(obs('Answer accepted',goal.value));assert.match(r.check(check(r,'resolved')),/goal is observed/);
 // This ledger never grants approval. The canonical executor owns all sends.
 assert.equal(r.permit('browser_action',{action:'click',sends_application:true}),undefined);
});

test('agent chooses an earlier technical stop; old forced-report blocks migrate without discarding work',()=>{
 const r=start();act(r,{action:'inspect',ref:'f0'});r.check(check(r,'blocked'));
 assert.equal(r.requiredTool,undefined);assert.equal(r.permit('finish',{status:'error'}),undefined);assert.equal(r.permit('prepare_application',{}),undefined);
 const saved=r.checkpoint();saved.task!.stopReason='Specialist recovery verification could not be completed: quotation mismatch';
 const resumed=new SpecialistRecovery(structuredClone(saved));resumed.observe(obs());assert.equal(resumed.blocked,false);assert.equal(resumed.requiredTool,undefined);
 resumed.observe({...obs(),inspectionError:'Unreadable frame'});assert.equal(resumed.permit('take_snapshot',{}),undefined);assert.match(resumed.permit('browser_action',{action:'click',ref:'a0'})!,/re-inspect/);
});

test('recovery is bounded before any specialist consultation and advice cannot reset it',()=>{
 const r=new SpecialistRecovery();r.observe(obs());
 r.complete('browser_action',{action:'click',ref:'a0'},'Original native interaction failed',true,true);r.observe(obs());
 assert.equal(view(r).attempts,0,'the original failure starts a blocker, not a recovery retry');assert.equal(r.consulted,false);
 r.respond(plan(r,'fill','Use supported keyboard input instead'),tools);act(r,{action:'fill',ref:'f0',value:'candidate answer'},true);
 r.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Another observed method is available.',recovery_goal:goal}));
 assert.equal(r.consulted,true);assert.equal(view(r).attempts,1,'a consultation cannot discard an executed approach');
 act(r,{action:'press',ref:'f0',value:'ArrowDown'},true);act(r,{action:'press',ref:'f0',value:'Space'},true);
 assert.match(r.permit('browser_action',{action:'press',ref:'f0',value:'Enter'})!,/three distinct/);
});

const referralLabel='How did you hear about this role?';
const referral=(value='',validationError?:string):Observation=>({...obs(),fields:[
 {ref:'f0',label:referralLabel,kind:'text',required:false,currentValue:value,validationError},
]});
const adviceFor=(value:string,target=referralLabel)=>'READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({
 advice:'Use the exact employer option supported by current evidence.',recovery_goal:{kind:'field-value',target,value},
});

test('new advice replaces a stale generic referral goal with the observed employer option',()=>{
 const r=new SpecialistRecovery();r.observe(referral());r.accept(adviceFor('Job board'));
 const action={action:'fill',ref:'f0',value:'Seek.com.au'};
 assert.equal(r.permit('browser_action',action),undefined);
 r.complete('browser_action',action,'Selected Seek.com.au',false,true);r.observe(referral('Seek.com.au'));
 assert.throws(()=>r.check(check(r,'resolved')),/not yet observed/,'reproduce the old literal mismatch');
 const old=view(r),history=structuredClone(r.checkpoint().task!.history);
 r.failedCheck('check_specialist_recovery','The old goal is not observed.');
 r.accept(adviceFor('Seek.com.au','f0'));
 const current=view(r);
 assert.deepEqual(current.verification,{kind:'field-value',target:referralLabel,value:'Seek.com.au'});
 assert.notEqual(current.advice_id,old.advice_id,'reports referring to the former goal become stale');
 assert.equal(current.goal_observed,true);assert.equal(r.pending,false);assert.equal(current.attempts,1);
 assert.deepEqual(r.checkpoint().task!.history,history);assert.equal(current.stopReason,undefined);
 assert.equal(r.checkpoint().task!.result,'Selected Seek.com.au','actual operation evidence is retained');
 assert.throws(()=>r.check({...check(r,'resolved'),advice_id:old.advice_id}),/actual operation/);
 assert.throws(()=>r.respond({...plan(r),advice_id:old.advice_id},tools),/stale/);
 assert.match(r.check(check(r,'resolved')),/goal is observed/);
 assert.equal(r.permit('prepare_application',{}),undefined,'normal preparation still owns its accuracy/approval checks');
 assert.equal(JSON.parse(r.checkpoint().task!.advice.split('\n').slice(1).join('\n')).recovery_goal.target,referralLabel);
 const restored=new SpecialistRecovery(structuredClone(r.checkpoint()));restored.observe(referral('Seek.com.au'));
 assert.equal(view(restored).advice_id,current.advice_id,'a consistent checkpoint does not revise the goal again');
});

test('a corrected goal still requires actual matching values without validation errors',()=>{
 for(const current of [referral('No Selection'),referral('Seek.com.au','Choose an option')]){
  const r=new SpecialistRecovery();r.observe(referral());r.accept(adviceFor('Job board'));
  r.complete('browser_action',{action:'inspect',ref:'f0'},'Actual field readback',false,true);r.observe(current);
  r.accept(adviceFor('Seek.com.au'));assert.equal(r.pending,true);
  assert.throws(()=>r.check(check(r,'resolved')),/not yet observed/);
 }
});

test('goal replacement preserves the spent approach limit and rejects malformed advice',()=>{
 const r=start();
 for(const args of [{action:'click',ref:'a0'},{action:'fill',ref:'f0',value:'attempt'},{action:'press',ref:'f0',value:'ArrowDown'}])act(r,args,true);
 const prior=structuredClone(r.checkpoint());
 assert.throws(()=>r.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Missing a goal'})),/verifiable recovery goal/);
 assert.deepEqual(r.checkpoint(),prior,'invalid new advice cannot alter the current goal');
 r.accept(adviceFor('Another supported answer','Answer'));
 assert.equal(view(r).attempts,3);assert.match(r.permit('browser_action',{action:'press',ref:'f0',value:'Tab'})!,/three distinct/);
 const id=view(r).advice_id;r.accept(adviceFor('Another supported answer','Answer'));
 assert.equal(view(r).advice_id,id,'repeated same advice is idempotent');
});

test('legacy mismatched checkpoint waits for fresh named field evidence before adopting its latest advice',()=>{
 const r=new SpecialistRecovery();r.observe(referral());r.accept(adviceFor('Job board'));
 r.complete('browser_action',{action:'fill',ref:'f0',value:'Seek.com.au'},'Actual selection result',false,true);
 const saved=structuredClone(r.checkpoint()),oldId=saved.task!.id;
 // Shape produced by the old accept() bug: new advice, old verification.
 saved.task!.advice=adviceFor('Seek.com.au');saved.task!.stopReason='Stale reporting feedback';
 const restored=new SpecialistRecovery(saved);
 restored.observe({...referral('Seek.com.au'),inspectionError:'Inspection failed'});
 assert.equal(view(restored).verification.value,'Job board');
 restored.observe(obs('A different field has the same transient ref','Seek.com.au'));
 assert.equal(view(restored).verification.value,'Job board','a reused field ref cannot authorize migration');
 restored.observe(referral('Seek.com.au'));
 assert.equal(view(restored).verification.value,'Seek.com.au');assert.notEqual(view(restored).advice_id,oldId);
 assert.equal(restored.pending,false);assert.equal(view(restored).attempts,1);
 assert.equal(restored.checkpoint().task!.result,'Actual selection result');
 assert.equal(view(restored).stopReason,undefined);
});
