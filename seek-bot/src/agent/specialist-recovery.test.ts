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
