import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SpecialistRecovery,sameSpecialistObservation} from './specialist-recovery.js';
import {renderObservation,type Observation} from './observe.js';
import type {ToolSchema} from './celeris.js';
import {specialistRecoveryTranscript,latestObservationScreenshotOnly} from './agent-only-transcript.js';
import type {ChatMessage} from './celeris.js';
const goal={kind:'field-value',target:'Cover letter',value:'Approved fictional letter'};
const advice='READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Inspect and restore the approved letter, then verify it.',recovery_goal:goal});
const observation=(step='Step 5',value='',ref='f0'):Observation=>({url:'https://fixture.invalid/apply',title:'Fictional application',text:step,fields:[{ref,label:'Cover letter',kind:'textarea',currentValue:value,disabled:false}as never],actions:[{ref:'a0',text:'Back',role:'button',disabled:false},{ref:'a1',text:'Next',role:'button',disabled:false}]});
const tools:ToolSchema[]=[{name:'browser_action',description:'fixture',parameters:{type:'object',additionalProperties:true}}];
const plan=(r:SpecialistRecovery,op:{name:string;args:Record<string,unknown>}={name:'browser_action',args:{action:'inspect',ref:'f0'}},extra={})=>({advice_id:r.checkpoint().task!.id,decision:'adopt',reason:'The letter is the observed blocker.',evidence_quote:'Fictional application',operation_tool:op.name,...(op.name==='browser_action'?{operation_action:op.args.action}:{}),operation_purpose:'Inspect or repair the current observed control.',verification:goal,...extra});
const verify=(r:SpecialistRecovery,assessment='resolved')=>({advice_id:r.checkpoint().task!.id,assessment,result_quote:'Cover letter',observation_quote:'Fictional application',reason:'Compared actual operation and current page evidence.'});
function complete(r:SpecialistRecovery,name:string,args:Record<string,unknown>,result:string,failed:boolean){assert.equal(r.permit(name,args),undefined);r.complete(name,args,result,failed);}
function start(){const r=new SpecialistRecovery();r.observe(observation());r.accept(advice);return r;}

test('required recovery generation keeps policy, candidate facts and fresh evidence without replaying obsolete plans',()=>{
 const messages:ChatMessage[]=[{role:'system',content:'Immutable safety policy'},{role:'user',content:'Candidate facts and approval'},
  {role:'assistant',content:null,tool_calls:[{id:'old',type:'function',function:{name:'browser_action',arguments:'{"action":"click","ref":"stale"}'}}]},
  {role:'tool',tool_call_id:'old',content:'Old Next click'},
  {role:'user',content:[{type:'text',text:'SPECIALIST RECOVERY OBLIGATION\nCurrent approved letter and actual tool result\nURL: https://fixture.invalid/apply'},{type:'image_url',image_url:{url:'data:image/png;base64,fictional'}}]}];
 const original=structuredClone(messages),view=specialistRecoveryTranscript(messages,'respond_to_specialist');
 assert.deepEqual(messages,original,'the retained audit transcript is untouched');
 assert.deepEqual(view.slice(0,2),messages.slice(0,2));assert.equal(view[2],messages[4]);
 assert.ok(!view.some(m=>m.role==='assistant'||m.role==='tool'));assert.match(String(view.at(-1)?.content),/exactly ONE respond_to_specialist/);
 assert.deepEqual(latestObservationScreenshotOnly(view)[2],messages[4],'checkpoint instructions must not retire the fresh screenshot');
 assert.throws(()=>specialistRecoveryTranscript(messages.slice(0,4),'respond_to_specialist'),/fresh browser observation/);
});
test('advice cannot execute itself and unacknowledged navigation/send/finish are refused',()=>{
 const r=start();assert.equal(r.requiredTool,'respond_to_specialist');
 for(const name of ['browser_action','prepare_application','finish'])assert.match(r.permit(name,{action:'click'} )!,/Not executed/);
 assert.match(r.respond(plan(r),tools),/nothing executed/);assert.equal(r.requiredTool,'browser_action');
 assert.match(r.permit('browser_action',{action:'click',ref:'a1'})!,/Not executed/);
 assert.equal(r.requiredTool,'respond_to_specialist','an unexecuted action mismatch needs a corrected decision');
 r.respond(plan(r),tools);
 assert.equal(r.permit('browser_action',{action:'inspect',ref:'f0'}),undefined);
});

test('a type-versus-press mismatch can be replanned before execution without clearing the recovery goal',()=>{
 const institution={kind:'field-value',target:'Institution *',value:'VTU'};
 const observed=(value=''):Observation=>({...observation(),fields:[{ref:'f13',label:'Institution *',kind:'combobox',currentValue:value,disabled:false}as never]});
 const r=new SpecialistRecovery();r.observe(observed());r.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Commit the observed VTU institution option using native keyboard interaction.',recovery_goal:institution}));
 const typed={action:'type',ref:'f13',value:'VTU'},pressed={action:'press',ref:'f13',value:'Enter'};
 r.respond(plan(r,{name:'browser_action',args:typed},{verification:institution}),tools);
 assert.match(r.permit('browser_action',pressed)!,/Not executed/);
 assert.equal(r.requiredTool,'respond_to_specialist');assert.equal(r.checkpoint().task!.operation,undefined,'a rejected call did not execute or bind an operation');
 assert.deepEqual(r.checkpoint().task!.verification,institution);assert.match(r.permit('finish',{status:'applied'})!,/Not executed/);
 const resumed=new SpecialistRecovery(structuredClone(r.checkpoint()));resumed.observe(observed());
 resumed.respond(plan(resumed,{name:'browser_action',args:pressed},{verification:institution,decision:'alternative',reason:'The open institution dropdown needs Enter to commit its selected option.'}),tools);
 complete(resumed,'browser_action',pressed,'Institution selection committed by native Enter',false);
 assert.match(resumed.permit('finish',{status:'applied'})!,/Not executed/,'execution alone cannot clear verification');
 resumed.observe(observed('VTU'));
 resumed.check({...verify(resumed),result_quote:'Institution selection committed'});assert.equal(resumed.pending,false);
});

test('documented target defaults match the committed native action without accepting another target or send',()=>{
 const r=start(),args={action:'click',locator:{by:'text',value:'Visible receiving label'},sends_application:false};
 r.respond(plan(r,{name:'browser_action',args}),tools);
 const actual={...args,target_mode:'locator',locator:{...args.locator,exact:true,frame:''}};
 assert.equal(r.permit('browser_action',actual),undefined);
 assert.match(r.permit('browser_action',{...actual,action:'press'})!,/Not executed/);
 assert.equal(r.requiredTool,'browser_action','a bound operation cannot be reset or retargeted');
 assert.match(r.permit('browser_action',{...actual,sends_application:true})!,/Not executed/);
 assert.match(r.permit('browser_action',{...actual,locator:{...actual.locator,value:'Different target'}})!,/Not executed/);
 assert.match(r.permit('browser_action',{...actual,target_mode:'selector',selector:'#other'})!,/Not executed/);
 complete(r,'browser_action',actual,'Cover letter recovery: native label clicked',false);assert.equal(r.requiredTool,'check_specialist_recovery');
 r.observe(observation());r.check(verify(r,'no_progress'));
 r.respond(plan(r,{name:'browser_action',args}),tools);assert.match(r.permit('browser_action',actual)!,/already ran/,'adding default metadata cannot evade repeated-operation history');
});
test('a plan or fabricated result cannot establish completion; real letter inspection can',()=>{
 const r=start();r.respond(plan(r),tools);
 assert.throws(()=>r.check(verify(r)),/fresh/);
 complete(r,'browser_action',{action:'inspect',ref:'f0'},'Cover letter is empty',false);r.observe(observation());
 assert.throws(()=>r.check(verify(r)),/not verified/);
 assert.throws(()=>r.check({...verify(r),result_quote:'Invented receipt'}),/actual recovery/);
 r.check(verify(r,'no_progress'));
 r.respond(plan(r,{name:'browser_action',args:{action:'fill',ref:'f0',value:goal.value}}),tools);
 complete(r,'browser_action',{action:'fill',ref:'f0',value:goal.value},'Cover letter updated',false);r.observe(observation('Step 2',goal.value));
 r.check(verify(r));assert.equal(r.pending,false);
 r.accept(advice);assert.equal(r.pending,true,'the same advice on the new observed state creates a fresh obligation');
});

test('quotes use actual rendered field rows and decoded native results, while exact refs can identify a goal',()=>{
 const r=new SpecialistRecovery(),o=observation('Step 2',goal.value);r.observe(o);r.accept(advice);
 const row=renderObservation(o).split('\n').find(line=>line.includes('[textarea]'))!.trim();
 assert.ok(row.includes('f0'));r.respond(plan(r,undefined,{evidence_quote:row,decision:'alternative',verification:{...goal,target:'f0'}}),tools);
 complete(r,'browser_action',{action:'inspect',ref:'f0'},JSON.stringify({ref:'f0',label:'Cover letter',value:goal.value,description:'Native "verified" readback'}),false);r.observe(o);
 r.check({...verify(r),result_quote:'Native "verified" readback',observation_quote:row});assert.equal(r.pending,false);
});

test('a reused wizard ref cannot resolve the original goal against a different control',()=>{
 assert.equal(sameSpecialistObservation(observation(),observation('Step 5','','renumbered')),true,'ref churn alone is not changed evidence');
 assert.equal(sameSpecialistObservation(observation(),{...observation(),url:observation().url+'#2'}),false,'wizard navigation is checked even before its DOM catches up');
 assert.equal(sameSpecialistObservation(observation(),observation('Step 2')),false,'same-URL DOM changes retire obsolete advice');
 const r=new SpecialistRecovery();r.observe(observation());r.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Inspect the actual letter',recovery_goal:{...goal,target:'f0'}}));
 assert.equal(r.checkpoint().task!.verification!.target,'Cover letter');r.respond(plan(r),tools);
 complete(r,'browser_action',{action:'inspect',ref:'f0'},'Cover letter inspected',false);
 r.observe({...observation('Step 3',goal.value),fields:[{...observation().fields[0],label:'Different wizard field',currentValue:goal.value}]});
 assert.throws(()=>r.check(verify(r)),/not verified/);
});
test('Treasury-style Back/Next cycle does not count as progress or satisfy the letter goal',()=>{
 const r=start(),back={name:'browser_action',args:{action:'click',ref:'a0'}},next={name:'browser_action',args:{action:'click',ref:'a1'}};
 r.respond(plan(r,back),tools);complete(r,back.name,back.args,'Cover letter repair: Back executed',false);r.observe(observation('Step 4'));r.check(verify(r,'progress'));
 r.respond(plan(r,next),tools);complete(r,next.name,next.args,'Cover letter repair: Next executed',false);r.observe(observation());
 assert.throws(()=>r.check(verify(r)),/not verified/);assert.throws(()=>r.check(verify(r,'progress')),/No new verified progress/);
 r.check(verify(r,'no_progress'));r.respond(plan(r,back),tools);assert.match(r.permit(back.name,back.args)!,/already ran/);
 // A genuinely different targeted inspection is still available.
 r.respond(plan(r),tools);assert.equal(r.requiredTool,'browser_action');
});
test('incorrect advice can be rejected only with current evidence and a checked alternative',()=>{
 const r=start();
 assert.throws(()=>r.respond(plan(r,undefined,{decision:'reject',evidence_quote:'Imaginary error message'}),tools),/current observed evidence/);
 const alternative={kind:'visible-text',target:'Step 5',value:'Step 5'};
 r.respond(plan(r,undefined,{decision:'reject',reason:'Current page contradicts the specialist assumption; inspect it directly.',verification:alternative}),tools);
 complete(r,'browser_action',{action:'inspect',ref:'f0'},'Cover letter page is Step 5',false);r.observe(observation());r.check(verify(r));assert.equal(r.pending,false);
});
test('failed operations, current state drift, stale decisions and old verification cannot clear recovery',()=>{
 const r=start();r.respond(plan(r),tools);r.observe(observation('Different page'));
 assert.match(r.permit('browser_action',{action:'inspect',ref:'f0'})!,/page changed/);assert.equal(r.requiredTool,'respond_to_specialist');
 assert.throws(()=>r.respond({...plan(r),advice_id:'wrong'},tools),/stale/);
 r.respond(plan(r),tools);complete(r,'browser_action',{action:'inspect',ref:'f0'},'Cover letter inspection failed',true);
 assert.throws(()=>r.check(verify(r)),/fresh/);r.observe(observation('Different page',goal.value));
 assert.throws(()=>r.check(verify(r)),/not verified/);r.check(verify(r,'blocked'));
 assert.match(r.permit('browser_action',{action:'click',sends_application:true})!,/Not executed/);assert.equal(r.requiredTool,'finish');assert.equal(r.permit('finish',{status:'skipped'}),undefined);
});
test('resumption retains the exact operation and verification obligation; private inputs never prove recovery',()=>{
 const r=start();r.respond(plan(r),tools);const resumed=new SpecialistRecovery(structuredClone(r.checkpoint()));resumed.observe(observation());
 assert.equal(resumed.requiredTool,'browser_action');complete(resumed,'browser_action',{action:'inspect',ref:'f0'},'Cover letter readback',false);
 resumed.observe({...observation('Step 2',goal.value),fields:[{...observation().fields[0],sensitive:true,currentValue:goal.value}]});
 assert.throws(()=>resumed.check(verify(resumed)),/not verified/);
});

test('an older retained exact-operation checkpoint keeps its original argument restriction',()=>{
 const r=start();r.respond(plan(r),tools);assert.equal(r.permit('browser_action',{action:'inspect',ref:'f0'}),undefined);
 const saved=structuredClone(r.checkpoint());delete saved.task!.plan;
 const resumed=new SpecialistRecovery(saved);resumed.observe(observation());
 assert.match(resumed.permit('browser_action',{action:'inspect',ref:'different'})!,/cannot be retargeted/);
 assert.equal(resumed.permit('browser_action',{action:'inspect',ref:'f0',target_mode:'ref'}),undefined);
});
test('unsafe specialist operations are refused and budget/receipt bookkeeping remains possible',()=>{
 const r=start();
 const optional=start(),intent=plan(optional);delete (intent as Record<string,unknown>).operation_action;optional.respond(intent,tools);
 assert.match(optional.permit('browser_action',{action:'script'})!,/cannot send|scripts/);assert.match(optional.permit('browser_action',{action:'click',sends_application:true})!,/cannot send/);assert.equal(optional.permit('browser_action',{action:'inspect',ref:'f0'}),undefined,'normal typed execution owns optional action metadata without expanding permissions');
 for(const op of [{name:'browser_action',args:{action:'script',code:'unsafe'}},{name:'finish',args:{status:'applied'}}])assert.throws(()=>r.respond(plan(r,op),tools),/supported native|offered normal/);
 r.respond(plan(r,{name:'browser_action',args:{action:'click'}}),tools);assert.match(r.permit('browser_action',{action:'click',sends_application:true})!,/cannot send/);
 assert.equal(r.permit('finish',{status:'skipped'},true),undefined,'budget completion cannot be trapped');
 assert.match(r.permit('finish',{status:'needs-human'},true)!,/Not executed/,'exhausting the budget with unfinished recovery cannot manufacture a candidate question');
 assert.equal(r.permit('finish',{status:'applied'},false,true),undefined,'already-observed receipt recording cannot be trapped');
 r.observe({...observation(),inspectionError:'Browser observation failed'});assert.equal(r.requiredTool,undefined);assert.equal(r.permit('browser_action',{action:'inspect'}),undefined);assert.equal(r.permit('browser_action',{action:'take_snapshot'}),undefined);assert.match(r.permit('browser_action',{action:'click'})!,/Not executed/);
});
test('invalid accountability responses stop after one correction instead of making another reporting loop',()=>{
 const r=start();r.failedCheck('respond_to_specialist','Unquoted evidence');assert.equal(r.requiredTool,'respond_to_specialist');
 const resumed=new SpecialistRecovery(structuredClone(r.checkpoint()));resumed.observe(observation());resumed.failedCheck('respond_to_specialist','Unquoted evidence');
 assert.equal(resumed.requiredTool,'finish');assert.match(resumed.permit('finish',{status:'needs-human'})!,/Not executed/,'a broken recovery protocol cannot manufacture a candidate question');assert.match(resumed.render(),/verification could not be completed/);
 assert.match(resumed.permit('finish',{status:'applied'})!,/Not executed/);
 resumed.reconsider();assert.equal(resumed.requiredTool,'respond_to_specialist','a normal contradictory halt assessment can request a different actual repair');
});
