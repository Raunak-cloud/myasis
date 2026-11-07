import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {ApplicationHelpers,helperRecipeExample,type HelperDefinition} from './application-helpers.js';
import {createReadinessFixtureReply} from './readiness-fixture.js';
import {ok} from './context.js';
import {withApplicationModel} from '../application-model.js';
import {fixtureToolArguments,isSpecialistFixtureRequest} from './specialist-fixture.js';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';

const directory=mkdtempSync(join(tmpdir(),'helper-integration-'));
Object.assign(process.env,{DATA_DIR:directory,APPLICATION_AI_MODEL:'minimax',OPENROUTER_API_KEY:'fictional-fixture-key',CELERIS_API_KEY:'fixture-only',ALLOW_EXTERNAL_APPLY:'true',DRY_RUN:'false',COST_TRACKING:'false',CELERIS_QUEUE_FILE:join(directory,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',OWTOMATE_LIVE_REPAIR:'',APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false',FORM_CORPUS_DIR:join(directory,'corpus')});
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes','cv.txt'),'Fictional candidate resume');writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture',fileName:'cv.txt'}]));
const {agentOnlyTools,runAgentOnlyApplication}=await import('./agent-only.js');
const {config}=await import('../config.js');config.dryRun=false;config.allowExternalApply=true;
const fetchBefore=globalThis.fetch;
after(()=>{globalThis.fetch=fetchBefore;closeCelerisQueues();rmSync(directory,{recursive:true,force:true});});
const str={type:'string',maxLength:200};
const parameters={type:'object',additionalProperties:false,properties:{target:str,value:str},required:['target','value']};
const filler:HelperDefinition={name:'fill_and_verify',description:'Fill one current uniquely scoped field and inspect its saved value.',parameters,
 steps:[{tool:'browser_action',args:{action:'fill',selector:{$input:'target'},value:{$input:'value'}}},{tool:'browser_action',args:{action:'inspect',selector:{$input:'target'}}}],
 tests:[{html:'<label>Duplicate name<input id=other></label><label>Actual name<input id=name oninput="window.events=(window.events||0)+1"></label>',input:{target:'#name',value:'Synthetic applicant'},assertions:[{step:1,path:'value',equals:'Synthetic applicant'}]}]};

test('helpers publish only after actual native fixture assertions; bad contracts and failed tests expose no tool',async()=>{
 const helpers=new ApplicationHelpers(agentOnlyTools);
 const published=await helpers.test(filler);assert.equal(published.status,'fixture-tested');assert.equal(helpers.schemas().length,1);
 assert.deepEqual(await helpers.test(filler),{name:published.name,status:'already-tested',tests:1});
 const bad=structuredClone(filler);bad.name='broken_readback';bad.tests[0].assertions[0].equals='Wrong';
 await assert.rejects(helpers.test(bad),/assertion failed/);assert.equal(helpers.schemas().length,1,'a failed test never becomes a callable tool');
 const unsafe=structuredClone(filler);unsafe.parameters.properties={target:{type:'string',maxLength:200,pattern:'(a+)+$'}};
 await assert.rejects(helpers.test(unsafe),/patterns/);
 const external=structuredClone(filler);external.steps[0]={tool:'open_emailed_link',args:{}};
 await assert.rejects(helpers.test(external),/must match|enum|capability|advertised/);
 const send=structuredClone(filler);send.steps[0]={tool:'browser_action',args:{action:'click',selector:'#send',sends_application:true}};
 await assert.rejects(helpers.test(send),/never submit/);
 assert.equal(helpers.schemas().length,1);
});

test('agent shorthand inputs become bounded closed schemas without extra model repair turns',async()=>{
 const helpers=new ApplicationHelpers(agentOnlyTools),short=structuredClone(filler);
 short.parameters={target:{type:'string'},value:{type:'string'}};
 const published=await helpers.test(short),schema=helpers.schemas()[0].parameters;
 const input=(schema.properties as any).input;
 assert.equal(input.type,'object');assert.equal(input.additionalProperties,false);assert.equal(input.properties.value.maxLength,40000);
 assert.equal(published.status,'fixture-tested');
});

test('the advertised complete recipe actually renders its asserted document bytes',async()=>{
 const helpers=new ApplicationHelpers(agentOnlyTools);
 assert.equal((await helpers.test({definition_json:JSON.stringify(helperRecipeExample)})).status,'fixture-tested');
 await assert.rejects(helpers.test({definition_json:'{broken'}),/valid JSON object/);
 await assert.rejects(helpers.test({definition_json:JSON.stringify(helperRecipeExample),unknown:'not allowed'}),/undeclared/);
 const denied=structuredClone(helperRecipeExample) as any;denied.steps[0]={tool:'open_emailed_link',args:{}};
 await assert.rejects(helpers.test({definition_json:JSON.stringify(denied)}),/enum|match|advertised|capability/);
});

test('a document helper creates and attaches a real combined document in an isolated inventory',async()=>{
 const helpers=new ApplicationHelpers(agentOnlyTools),expected='Synthetic cover letter\n\nSynthetic resume';
 const definition:HelperDefinition={name:'combined_document',description:'Create one document containing both supplied texts and attach it to the supplied input.',parameters:{type:'object',additionalProperties:false,properties:{letter:str,resume:str,target:str},required:['letter','resume','target']},
  steps:[{tool:'create_file',args:{name:'Combined.txt',text:{$concat:[{$input:'letter'},'\n\n',{$input:'resume'}]},format:'txt'}},
   {tool:'browser_action',args:{action:'set_input_files',selector:{$input:'target'},file_ids:[{$result:'0.file_id'}]}},
   {tool:'browser_action',args:{action:'script',script:'async()=>({text:await document.querySelector("input[type=file]").files[0].text()})',script_intent:'inspect'}}],
  tests:[{html:'<input id=document type=file>',input:{letter:'Synthetic cover letter',resume:'Synthetic resume',target:'#document'},assertions:[{step:2,path:'text',equals:expected}]}]};
 assert.equal((await helpers.test(definition)).status,'fixture-tested');
 assert.equal(helpers.schemas().length,1);
});

test('helper fixtures resolve repeated labels through nested frames and shadow DOM after delayed rerender',async()=>{
 const helpers=new ApplicationHelpers(agentOnlyTools);
 const definition:HelperDefinition={name:'nested_control',description:'Fill the current control inside a nested frame after its asynchronous replacement.',parameters:{type:'object',additionalProperties:false,properties:{value:str},required:['value']},
  steps:[{tool:'browser_action',args:{action:'script',script:'()=>{const outer=document.createElement("iframe");outer.id="outer";document.body.append(outer);const inner=outer.contentDocument.createElement("iframe");inner.id="inner";outer.contentDocument.body.append(inner);const doc=inner.contentDocument;doc.body.innerHTML="<label>Name<input id=decoy></label><section id=target></section>";const root=doc.querySelector("#target").attachShadow({mode:"open"});root.innerHTML="<label>Name<input id=chosen></label>";setTimeout(()=>{root.innerHTML="<label>Name<input id=chosen></label>";root.querySelector("input").dataset.ready="yes"},70);return {created:true}}',script_intent:'act'}},
   {tool:'browser_action',args:{action:'script',script:{$concat:['async()=>{const doc=document.querySelector("#outer").contentDocument.querySelector("#inner").contentDocument;let input;for(let i=0;i<20;i++){input=doc.querySelector("#target").shadowRoot.querySelector("input[data-ready=yes]");if(input)break;await new Promise(r=>setTimeout(r,20))}if(!input)throw Error("Delayed control missing");input.value=',{$json:{$input:'value'}},';input.dispatchEvent(new Event("input",{bubbles:true}));return {saved:input.value,decoy:doc.querySelector("#decoy").value}}']},script_intent:'act'}}],
  tests:[{html:'<main>Nested synthetic fixture</main>',input:{value:'Synthetic nested answer'},assertions:[{step:1,path:'saved',equals:'Synthetic nested answer'},{step:1,path:'decoy',equals:''}]}]};
 assert.equal((await helpers.test(definition)).status,'fixture-tested');
});

test('helper continuation resumes after completed operations, reroutes each primitive through the parent and cannot cross attempts',async()=>{
 const helpers=new ApplicationHelpers(agentOnlyTools),published=await helpers.test(filler),name=String(published.name),calls:string[]=[];
 const first=await helpers.execute(name,{input:{target:'#name',value:'Fixture'}},async(tool,args)=>{calls.push(tool+':'+args.action);return args.action==='fill'?ok('{"current":{"value":"Fixture"}}'):ok('Stale field. Inspect again.','reobserve');},()=>true);
 assert.equal(first.kind,'ok');const continuation=JSON.parse(first.kind==='ok'?first.message:'').continuation;
 assert.ok(continuation);assert.equal(calls.length,2);
 const second=await helpers.execute(name,{input:{target:'#fresh',value:'Fixture'},continuation},async()=>{throw Error('Completed operations must not replay');},()=>true);
 assert.equal(second.kind,'ok');assert.equal(JSON.parse(second.kind==='ok'?second.message:'').completedSteps,2);
 await assert.rejects(helpers.execute(name,{input:{target:'#fresh',value:'Fixture'},continuation},async()=>ok(''),()=>true),/consumed/);
 assert.equal(new ApplicationHelpers(agentOnlyTools).has(name),false);
 const denied=await helpers.execute(name,{input:{target:'#name',value:'Fixture'}},async()=>ok('Normal permission refusal','failed'),()=>true);
 assert.equal(denied.kind==='ok'&&denied.disposition,'failed','normal permission results are not turned into helper success');
 assert.equal(JSON.parse(denied.kind==='ok'?denied.message:'').continuation,undefined,'uncertain failed actions never get an automatic retry token');
});

for(const provider of ['celeris','minimax'])for(const mode of ['auto','prepare']){
 test(`the applying agent builds and uses its own helper: ${provider}, ${mode}`,async()=>{
  process.env.APPLICATION_REVIEW_MODE=mode==='prepare'?'prepare':'';
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
  try{
   const context=await browser.newContext(),page=await context.newPage(),url='https://employer.helper.invalid/apply';
   await context.route('**/*',route=>new URL(route.request().url()).hostname==='employer.helper.invalid'?route.fulfill({contentType:'text/html',body:'<main><label>Name<input id=name oninput="localStorage.setItem(\'edits\',String(Number(localStorage.getItem(\'edits\')||0)+1))"></label><button id=send onclick="localStorage.setItem(\'sends\',String(Number(localStorage.getItem(\'sends\')||0)+1));document.querySelector(\'main\').innerHTML=\'Application received: HELPER-FIXTURE\'">Submit application</button></main>'}):route.abort());
   await page.goto(url);let parent=0,helperName='';const readiness=createReadinessFixtureReply();
   const bad=structuredClone(filler);bad.tests[0].assertions[0].equals='Incorrect expected value';
   globalThis.fetch=(async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    assert.equal(isSpecialistFixtureRequest(body),false,'no specialist model request');
    assert.ok(!body.tools.some((t:any)=>/consult_application_specialist|return_application_advice/.test(t.function.name)));
    const review=readiness(body);if(review)return review;
    let call:{name:string;args:Record<string,unknown>};
    const last=body.messages.filter((m:any)=>m.role==='tool').at(-1)?.content;
    if(parent===0){
     assert.ok(body.tools.some((t:any)=>t.function.name==='test_application_helper'));
     assert.ok(!body.tools.some((t:any)=>t.function.name.startsWith('helper_')),'previous applications do not leak helpers');
     call={name:'test_application_helper',args:{definition_json:JSON.stringify(bad)}};
    }else if(parent===1){
     const feedback=JSON.parse(last);assert.equal(feedback.status,'test-failed');assert.equal(feedback.published,false);
     assert.ok(!body.tools.some((t:any)=>t.function.name.startsWith('helper_')));
     assert.equal(await page.locator('#name').inputValue(),'','failed tests never edit the employer form');
     call={name:'test_application_helper',args:{definition_json:JSON.stringify(filler)}};
    }else if(parent===2){
     const published=JSON.parse(last);assert.equal(published.status,'fixture-tested');helperName=published.name;
     assert.ok(body.tools.some((t:any)=>t.function.name===helperName),'the new tool is available on the next turn');
     assert.equal(await page.locator('#name').inputValue(),'','successful tests also leave the employer form alone');
     call={name:helperName,args:{input:{target:'#name',value:'Fictional Candidate'}}};
    }else if(parent===3){
     assert.equal(await page.locator('#name').inputValue(),'Fictional Candidate');
     assert.equal(await page.evaluate(() => Number(localStorage.getItem('edits')||0)),1,'only live execution emits an input event');
     call=mode==='prepare'?{name:'prepare_application',args:{answers:[{question:'Name',answer:'Fictional Candidate'}],resume_id:'cv',submit_selector:'#send'}}
       :{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}};
    }else if(parent===4&&mode==='auto'){
     call={name:'finish',args:{status:'applied',reason:'Fixture receipt observed.',evidence:'Application received: HELPER-FIXTURE',receipt:{quote:'Application received: HELPER-FIXTURE'}}};
    }else throw Error('Unexpected extra applying-agent turn');
    parent++;
    return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'helper-call-'+parent,type:'function',function:{name:call.name,arguments:fixtureToolArguments(body,call.name,call.args)}}]}}],usage:{prompt_tokens:100,completion_tokens:30,cost:.001}});
   }) as typeof fetch;
   const result=await withApplicationModel({...process.env,APPLICATION_AI_MODEL:provider,APPLICATION_REVIEW_MODE:mode==='prepare'?'prepare':''},()=>runAgentOnlyApplication({page,job:{id:`helper-${provider}-${mode}`,title:'Fictional developer',company:'Fixture',location:'Sydney',platform:'workday',url},profile:{name:'Fictional Candidate',email:'fictional@example.invalid',skills:[]} as never,log:()=>{}}));
   assert.equal(result.outcome.status,mode==='prepare'?'prepared':'applied');
   assert.equal(result.submitPressed,mode==='auto');assert.equal(parent,mode==='prepare'?4:5);
   assert.equal(await page.evaluate(() => Number(localStorage.getItem('sends')||0)),mode==='prepare'?0:1);
   assert.equal(await page.evaluate(() => Number(localStorage.getItem('edits')||0)),1);
  }finally{globalThis.fetch=fetchBefore;await browser.close();}
 });
}
