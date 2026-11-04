import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'patchright';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';
import {createReadinessFixtureReply} from './readiness-fixture.js';
import {fixtureToolArguments} from './specialist-fixture.js';

test('explicit letter inspection survives a wizard handoff and permits one approved fictional submission',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'approved-letter-recovery-'));
 Object.assign(process.env,{DATA_DIR:dir,CELERIS_API_KEY:'fixture-only',CELERIS_QUEUE_FILE:join(dir,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',APPLICATION_AI_MODEL:'celeris',APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false',APPLICATION_REVIEW_MODE:'approved',COST_TRACKING:'false'});
 const {config}=await import('../config.js');config.dryRun=true;config.allowExternalApply=true;
 const {runAgentOnlyApplication}=await import('./agent-only.js');
 const job={id:'letter-wizard',title:'Fictional Analyst',company:'Fixture',location:'Sydney',platform:'seek' as const,url:'https://letter-wizard.fixture.invalid/apply'};
 const letter='Dear fictional employer,\n\nThis is the exact approved cover letter.\n\nFictional Candidate';
 const draft={id:'f67ea042-08f4-4a0a-b511-c0b30a876028',revision:'b'.repeat(64),job,preparedAt:new Date().toISOString(),formUrl:job.url,answers:[],coverLetter:letter,resume:'CV.txt',resumeId:'cv',resumeHash:createHash('sha256').update('Fictional CV').digest('hex')};
 mkdirSync(join(dir,'resumes'));writeFileSync(join(dir,'resumes/CV.txt'),'Fictional CV');writeFileSync(join(dir,'resumes.json'),JSON.stringify([{id:'cv',label:'CV',fileName:'CV.txt'}]));writeFileSync(join(dir,'approved-applications.json'),JSON.stringify([draft]));
 const originalFetch=globalThis.fetch,browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
 try{
  const page=await browser.newPage();page.on('pageerror',error=>console.error('FIXTURE PAGE ERROR',error.message));
  await page.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:`<main><h1>Fictional Analyst</h1><div id=editor><label>Resume<input id=cv type=file></label><div id=letter-label>Cover letter</div><textarea id=letter aria-labelledby=letter-label></textarea><button id=next onclick="document.querySelector('#editor').hidden=true;document.querySelector('#review').hidden=false">Next</button></div><div id=review hidden><p>Step 5 of 5</p><button id=send onclick="localStorage.setItem(&quot;send-count&quot;,String(Number(localStorage.getItem(&quot;send-count&quot;)||0)+1));document.querySelector('#receipt').textContent='Application received for Fictional Analyst.'">Submit</button></div><p id=receipt></p></main>`}):route.abort());
  await page.goto(job.url);
  const calls=[
   {name:'browser_action',args:{action:'set_input_files',selector:'#cv',file_ids:['cv']}},
   {name:'browser_action',args:{action:'fill',selector:'#letter',value:letter}},
   {name:'browser_action',args:{action:'inspect',selector:'#letter'}},
   {name:'browser_action',args:{action:'click',selector:'#next',sends_application:false}},
   {name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}},
   {name:'finish',args:{status:'applied',reason:'The fictional employer receipt confirms delivery.',evidence:'Actual receipt text is visible.',receipt:{quote:'Application received for Fictional Analyst.'}}},
  ];let turn=0;
  const readiness=createReadinessFixtureReply();
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));assert.equal(body.model,'celeris-1-magnus');
   const reviewed=readiness(body);if(reviewed)return reviewed;
   const call=calls[turn++];assert.ok(call,'No extra recovery loop is permitted in this fixture');
   if(call.name==='finish')assert.equal(await page.locator('#receipt').textContent(),'Application received for Fictional Analyst.','the actual fake employer must produce its receipt before the fixture can claim applied');
   if(call.args.action==='click'&&call.args.selector==='#send')config.dryRun=false;
   return Response.json({usage:{prompt_tokens:100,completion_tokens:10},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'wizard-'+turn,type:'function',function:{name:call.name,arguments:fixtureToolArguments(body,call.name,call.args)}}]}}]});
  };
  const result=await runAgentOnlyApplication({simulation:'isolated-form',page,job,profile:{name:'Fictional Candidate',email:'fixture@example.invalid',skills:[]}as never,log:()=>{}});
  assert.equal(result.outcome.status,'applied');assert.equal(await page.evaluate(()=>Number(localStorage.getItem('send-count')||0)),1);assert.equal(result.submitPressed,true);assert.equal(turn,6);
  assert.equal(await page.locator('#letter').inputValue(),letter,'the exact approved text remains unchanged');
  const {AgentFiles}=await import('./agent-files.js');const files=new AgentFiles(job.id,draft);
  const native={tag:'textarea',type:'textarea',visible:true,private:false,disabled:false,label:'Cover letter',value:letter,ref:'f0'};
  files.witnessInspectedLetter(native);assert.ok(files.checkpointLetterWitness());
  files.recheckLetterWitness([{ref:'f0',label:'Cover letter',kind:'textarea',required:false,currentValue:''}]);assert.equal(files.checkpointLetterWitness(),undefined,'fresh blank revokes old proof');
  files.witnessInspectedLetter({...native,value:'Different text'});assert.equal(files.checkpointLetterWitness(),undefined);
  files.witnessInspectedLetter({...native,private:true});assert.equal(files.checkpointLetterWitness(),undefined);
  const bound={ref:'f0',label:'Cover letter',kind:'textarea' as const,required:false,controlIdentity:'textarea@fixture'};
  files.witnessInspectedLetter({...native,label:null,controlIdentity:bound.controlIdentity},[bound]);assert.ok(files.checkpointLetterWitness(),'missing native label binds only to one current observed control identity');files.clearLetterWitness();
  files.witnessInspectedLetter({...native,label:null,controlIdentity:'textarea@other'},[bound]);assert.equal(files.checkpointLetterWitness(),undefined,'a different control cannot borrow the observed label');
  files.witnessInspectedLetter({...native,label:null,controlIdentity:bound.controlIdentity},[bound,bound]);assert.equal(files.checkpointLetterWitness(),undefined,'ambiguous identities cannot establish proof');
  files.witnessInspectedLetter(native);files.witnessInspectedLetter({...native,invalid:'true'});assert.equal(files.checkpointLetterWitness(),undefined,'validation errors revoke readback proof');
  files.witnessInspectedLetter({matched:2,fields:[native,native]});assert.equal(files.checkpointLetterWitness(),undefined,'ambiguous readback cannot create proof');
  files.witnessInspectedLetter(native);files.clearLetterWitness();assert.equal(files.checkpointLetterWitness(),undefined,'cancel/escape invalidation cannot leave a usable witness');
 }finally{globalThis.fetch=originalFetch;await browser.close();closeCelerisQueues();assert.ok(dir.startsWith(join(tmpdir(),'approved-letter-recovery-')));rmSync(dir,{recursive:true,force:true});}
});
