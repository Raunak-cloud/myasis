/** Fictional forms, real browsers/executors, scripted decisions. No paid calls. */
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {ApplicationHelpers,helperBrowserRecipeExample,type HelperDefinition} from './application-helpers.js';
import {ok} from './context.js';
import {withApplicationModel} from '../application-model.js';
import {fixtureToolArguments,isSpecialistFixtureRequest} from './specialist-fixture.js';
import {createReadinessFixtureReply} from './readiness-fixture.js';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';

const directory=mkdtempSync(join(tmpdir(),'helper-simulation-'));
Object.assign(process.env,{DATA_DIR:directory,APPLICATION_AI_MODEL:'celeris',CELERIS_API_KEY:'fixture-only',OPENROUTER_API_KEY:'fixture-only',
  CELERIS_QUEUE_FILE:join(directory,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',COST_TRACKING:'false',DRY_RUN:'false',ALLOW_EXTERNAL_APPLY:'true',
  OWTOMATE_LIVE_REPAIR:'',APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false',FORM_CORPUS_DIR:join(directory,'corpus')});
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes','CV.txt'),'Fictional candidate. Sydney.');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt'}]));
const {agentOnlyTools,runAgentOnlyApplication}=await import('./agent-only.js');
const {config}=await import('../config.js');config.dryRun=false;config.allowExternalApply=true;
const originalFetch=globalThis.fetch;
after(()=>{globalThis.fetch=originalFetch;closeCelerisQueues();rmSync(directory,{recursive:true,force:true});});
const parameters={properties:{value:{type:'string'}},required:['value']};
const simple:HelperDefinition={name:'fill_value',description:'Fill the supplied dummy value and inspect the saved value.',parameters,
  steps:[{tool:'browser_action',args:{action:'fill',selector:'#value',value:{$input:'value'}}},{tool:'browser_action',args:{action:'inspect',selector:'#value'}}],
  tests:[{html:'<label>Value<input id=value></label>',input:{value:'Dummy'},assertions:[{step:1,path:'value',equals:'Dummy'}]}]};

test('the browser recipe advertised to real models executes and wrong result paths give corrective evidence',async()=>{
  const helpers=new ApplicationHelpers(agentOnlyTools);assert.equal((await helpers.test(helperBrowserRecipeExample)).status,'fixture-tested');
  const wrong=structuredClone(simple);wrong.tests[0].assertions[0]={step:0,path:'value',equals:'Dummy'};
  wrong.steps.pop();
  await assert.rejects(helpers.test(wrong),/missing path value.*Actual returned object:.*current.*current.value/);
  assert.equal(helpers.schemas().length,1,'the incorrect recipe is not published');
});

test('an interrupted helper resumes remaining operations with fresh inputs and a single-use token',async()=>{
  const helpers=new ApplicationHelpers(agentOnlyTools),definition=structuredClone(simple);
  definition.steps.splice(1,0,{tool:'browser_action',args:{action:'wait',selector:'#ready',timeout_ms:20}});
  definition.tests[0].html+='<p id=ready>Ready</p>';definition.tests[0].assertions[0].step=2;
  const {name}=await helpers.test(definition),calls:string[]=[];
  const first=await helpers.execute(String(name),{input:{value:'Original'}},async(_tool,args)=>{
    calls.push(String(args.action));return args.action==='wait'?ok('Observe changed controls','reobserve'):ok('{}');
  },()=>true);
  assert.equal(first.kind,'ok');if(first.kind!=='ok')throw Error('Unexpected terminal');
  const state=JSON.parse(first.message);assert.equal(state.completedSteps,2);assert.deepEqual(calls,['fill','wait']);
  const resumed=await helpers.execute(String(name),{input:{value:'Fresh'},continuation:state.continuation},async(_tool,args)=>{
    calls.push(String(args.action));return ok('{"value":"Original"}');
  },()=>true);
  assert.equal(resumed.kind,'ok');assert.deepEqual(calls,['fill','wait','inspect']);
  assert.equal(JSON.parse(resumed.kind==='ok'?resumed.message:'').result.value,'Original');
  await assert.rejects(helpers.execute(String(name),{input:{value:'Fresh'},continuation:state.continuation},async()=>ok(''),()=>true),/consumed/);
});

test('exhausted shared budgets stop before the next operation without replaying completed work',async()=>{
  const helpers=new ApplicationHelpers(agentOnlyTools),{name}=await helpers.test(simple);let calls=0;
  const none=await helpers.execute(String(name),{input:{value:'Dummy'}},async()=>{calls++;return ok('{}');},()=>false);
  assert.equal(calls,0);assert.equal(none.kind==='ok'&&none.disposition,'failed');
  const part=await helpers.execute(String(name),{input:{value:'Dummy'}},async()=>{calls++;return ok('{}');},()=>calls===0);
  assert.equal(calls,1);assert.equal(part.kind==='ok'&&part.disposition,'failed');
  assert.equal(JSON.parse(part.kind==='ok'?part.message:'').completedSteps,1);
});

test('partial failures and terminal outcomes propagate rather than becoming helper success',async()=>{
  const helpers=new ApplicationHelpers(agentOnlyTools),{name}=await helpers.test(simple);let calls=0;
  const failed=await helpers.execute(String(name),{input:{value:'Dummy'}},async()=>++calls===1?ok('{}'):ok('Control replaced','failed'),()=>true);
  assert.equal(calls,2);assert.equal(failed.kind==='ok'&&failed.disposition,'failed');
  const feedback=JSON.parse(failed.kind==='ok'?failed.message:'');assert.equal(feedback.completedSteps,1);assert.equal(feedback.continuation,undefined);
  const terminal={kind:'terminal' as const,outcome:{status:'needs-human' as const,reason:'Fictional missing personal answer'}};
  assert.deepEqual(await helpers.execute(String(name),{input:{value:'Dummy'}},async()=>terminal,()=>true),terminal);
});

test('invalid arguments and unknown templates publish nothing and never invoke live executors',async()=>{
  const helpers=new ApplicationHelpers(agentOnlyTools);
  for(const template of [{$input:'missing'},{$result:'9.value'},{$literal:'unsupported'},JSON.parse('{"__proto__":1}')]){
    const bad=structuredClone(simple);bad.steps[0].args.value=template;
    await assert.rejects(helpers.test(bad));assert.equal(helpers.schemas().length,0);
  }
  const {name}=await helpers.test(simple);let called=false;
  for(const args of [{input:{}},{input:{value:7}},{input:{value:'Dummy',extra:true}},{input:{value:'Dummy'},extra:true}]){
    await assert.rejects(helpers.execute(String(name),args,async()=>{called=true;return ok('');},()=>true));
  }
  assert.equal(called,false);
});

test('helpers inherit the existing mode capabilities, including the absence of browser scripts',async()=>{
  const nativeOnly=agentOnlyTools.map(tool=>tool.name==='browser_action'?{...tool,parameters:{...tool.parameters,
    properties:{...(tool.parameters.properties as object),action:{type:'string',enum:['fill','inspect']}}}}:tool);
  const helpers=new ApplicationHelpers(nativeOnly),script=structuredClone(simple);
  script.steps=[{tool:'browser_action',args:{action:'script',script:'()=>({value:"Dummy"})',script_intent:'inspect'}}];script.tests[0].assertions[0].step=0;
  await assert.rejects(helpers.test(script),/enum|match|script/);assert.equal(helpers.schemas().length,0);
  assert.equal((await helpers.test(simple)).status,'fixture-tested');
});

test('synthetic tests have no candidate cookies, saved browser data, host runtime or external network',async()=>{
  const helpers=new ApplicationHelpers(agentOnlyTools);
  const isolated:HelperDefinition={name:'probe_isolation',description:'Inspect only the isolated synthetic helper browser environment.',parameters:{properties:{}},
    steps:[{tool:'browser_action',args:{action:'script',script:'async()=>({cookie:document.cookie,saved:localStorage.getItem("candidate-secret"),host:typeof process,network:await fetch("https://outside-network.invalid/probe").then(()=>true,()=>false)})',script_intent:'inspect'}}],
    tests:[{html:'<main>Dummy isolation fixture</main>',input:{},assertions:[{step:0,path:'cookie',equals:''},{step:0,path:'saved',equals:null},{step:0,path:'host',equals:'undefined'},{step:0,path:'network',equals:false}]}]};
  assert.equal((await helpers.test(isolated)).status,'fixture-tested');
});

test('every supplied fixture must pass and identical recipes stay local to their application',async()=>{
  const helpers=new ApplicationHelpers(agentOnlyTools),multi=structuredClone(simple);
  multi.tests.push(structuredClone(multi.tests[0]));multi.tests[1].assertions[0].equals='Incorrect';
  await assert.rejects(helpers.test(multi),/assertion failed/);assert.equal(helpers.schemas().length,0);
  const published=await helpers.test(simple),again=await helpers.test(simple);
  assert.equal(again.status,'already-tested');assert.equal(helpers.schemas().length,1);
  const other=new ApplicationHelpers(agentOnlyTools);assert.equal(other.has(String(published.name)),false);
  await assert.rejects(other.execute(String(published.name),{input:{value:'Dummy'}},async()=>ok(''),()=>true),/successfully tested/);
});

test('a stuck synthetic script times out without publishing and leaves the helper builder usable',{timeout:25000},async()=>{
  const helpers=new ApplicationHelpers(agentOnlyTools),stuck=structuredClone(simple);
  stuck.steps=[{tool:'browser_action',args:{action:'script',script:'()=>{while(true){}}',script_intent:'inspect'}}];stuck.tests[0].assertions[0].step=0;
  const started=Date.now();await assert.rejects(helpers.test(stuck));assert.ok(Date.now()-started<22000);
  assert.equal(helpers.schemas().length,0);assert.equal((await helpers.test(simple)).status,'fixture-tested');
});

type Call={name:string;args:Record<string,unknown>};
for(const provider of ['celeris','minimax'])for(const mode of ['auto','prepare'])for(const scenario of ['documents','resume-after-wait']){
  test(`full applying simulation: ${scenario}, ${provider}, ${mode}`,async()=>{
    process.env.APPLICATION_REVIEW_MODE=mode==='prepare'?'prepare':'';
    const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
    try{
      const context=await browser.newContext(),page=await context.newPage();
      const url=`https://helper-simulation.invalid/${provider}/${mode}/${scenario}`;
      const html=`<main><h1>Fictional developer at Fixture, Sydney</h1>
        <label>Name<input id=value oninput="localStorage.setItem('name-edits',String(Number(localStorage.getItem('name-edits')||0)+1))"></label>
        <label>City<input id=city oninput="localStorage.setItem('city-edits',String(Number(localStorage.getItem('city-edits')||0)+1))"></label>
        <p id=ready hidden>Ready</p><button id=reveal onclick="document.querySelector('#ready').hidden=false">Show next section</button>
        <label>Supporting document<input type=file id=document></label>
        <button id=send onclick="localStorage.setItem('sends',String(Number(localStorage.getItem('sends')||0)+1));document.querySelector('main').innerHTML='Application received: HELPER-SIMULATION'">Submit application</button></main>`;
      await context.route('**/*',route=>new URL(route.request().url()).origin==='https://helper-simulation.invalid'?route.fulfill({contentType:'text/html',body:html}):route.abort());
      await page.goto(url);await context.addCookies([{name:'candidate-secret',value:'must-not-enter-helper-tests',url}]);
      await page.evaluate(()=>localStorage.setItem('candidate-secret','must-not-enter-helper-tests'));
      const definition:HelperDefinition=scenario==='documents'?{name:'make_supporting_pdf',description:'Create a supporting statement and convert it into an uploadable PDF.',parameters,
        steps:[{tool:'create_file',args:{name:'Statement.txt',text:{$input:'value'},format:'txt'}},{tool:'convert_file',args:{file_id:{$result:'0.file_id'},format:'pdf'}}],
        tests:[{html:'<main>Document fixture</main>',input:{value:'Dummy supporting statement'},assertions:[{step:1,path:'format',equals:'pdf'}]}]}:structuredClone(simple);
      if(scenario!=='documents'){
        definition.steps.splice(1,0,{tool:'browser_action',args:{action:'wait',selector:'#ready',timeout_ms:30}});
        definition.steps[2]={tool:'browser_action',args:{action:'fill',selector:'#city',value:'Sydney'}};
        definition.tests[0].html+='<p id=ready>Ready</p><label>City<input id=city></label>';
        definition.tests[0].assertions=[{step:2,path:'current.value',equals:'Sydney'}];
      }
      let turn=0,helperName='',continuation='',fileId='';const readiness=createReadinessFixtureReply();
      globalThis.fetch=(async(_url,init)=>{
        const body=JSON.parse(String(init?.body));assert.equal(isSpecialistFixtureRequest(body),false);
        const review=readiness(body);if(review)return review;
        const last=body.messages.filter((message:any)=>message.role==='tool').at(-1)?.content;
        let call:Call;
        if(turn===0){
          assert.ok(!body.tools.some((tool:any)=>tool.function.name.startsWith('helper_')));
          call={name:'test_application_helper',args:{definition_json:JSON.stringify(definition)}};
        }else if(turn===1){
          const published=JSON.parse(last);helperName=published.name;assert.equal(published.status,'fixture-tested');
          assert.ok(body.tools.some((tool:any)=>tool.function.name===helperName));
          assert.equal(await page.locator('#value').inputValue(),'');assert.equal(await page.locator('#document').evaluate((input:HTMLInputElement)=>input.files?.length),0);
          call={name:helperName,args:{input:{value:scenario==='documents'?'Fictional Candidate. Evidence-based supporting statement.':'Fictional Candidate'}}};
        }else if(turn===2){
          const result=JSON.parse(last);
          if(scenario==='documents'){
            assert.equal(result.result.format,'pdf');fileId=result.result.file_id;
            call={name:'browser_action',args:{action:'set_input_files',selector:'#document',file_ids:[fileId]}};
          }else{
            assert.equal(result.completedSteps,2);continuation=result.continuation;assert.ok(continuation);
            assert.equal(await page.locator('#value').inputValue(),'Fictional Candidate');assert.equal(await page.locator('#city').inputValue(),'');
            call={name:'browser_action',args:{action:'click',selector:'#reveal',sends_application:false}};
          }
        }else if(turn===3&&scenario!=='documents'){
          call={name:helperName,args:{input:{value:'Do not replay this value'},continuation}};
        }else if(turn===(scenario==='documents'?3:4)){
          if(scenario==='documents'){
            const file=await page.locator('#document').evaluate(async(input:HTMLInputElement)=>({name:input.files![0].name,header:(await input.files![0].text()).slice(0,5),bytes:input.files![0].size}));
            assert.match(file.name,/\.pdf$/);assert.equal(file.header,'%PDF-');assert.ok(file.bytes>100);
          }else{
            assert.equal(await page.locator('#value').inputValue(),'Fictional Candidate');assert.equal(await page.locator('#city').inputValue(),'Sydney');
            assert.deepEqual(await page.evaluate(()=>[Number(localStorage.getItem('name-edits')),Number(localStorage.getItem('city-edits'))]),[1,1]);
          }
          call=mode==='prepare'?{name:'prepare_application',args:{answers:[],resume_id:'cv',submit_selector:'#send',...(fileId?{supporting_file_ids:[fileId]}:{})}}
            :{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}};
        }else if(mode==='auto'&&turn===(scenario==='documents'?4:5)){
          call={name:'finish',args:{status:'applied',reason:'Fictional employer receipt observed.',evidence:'Application received: HELPER-SIMULATION',receipt:{quote:'Application received: HELPER-SIMULATION'}}};
        }else throw Error(`Unexpected simulation turn ${turn}: ${String(last).slice(0,1500)}`);
        return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`sim-${++turn}`,type:'function',function:{name:call.name,arguments:fixtureToolArguments(body,call.name,call.args)}}]}}],usage:{prompt_tokens:100,completion_tokens:25,cost:.001}});
      }) as typeof fetch;
      const result=await withApplicationModel({...process.env,APPLICATION_AI_MODEL:provider},()=>runAgentOnlyApplication({page,
        job:{id:`sim-${scenario}-${provider}-${mode}`,title:'Fictional developer',company:'Fixture',location:'Sydney',platform:'workday',url},
        profile:{name:'Fictional Candidate',email:'fixture@example.invalid',skills:[]} as never,log:()=>{}}));
      assert.equal(result.outcome.status,mode==='prepare'?'prepared':'applied');assert.equal(result.submitPressed,mode==='auto');
      assert.equal(await page.evaluate(()=>Number(localStorage.getItem('sends')||0)),mode==='auto'?1:0);
    }finally{globalThis.fetch=originalFetch;await browser.close();}
  });
}
