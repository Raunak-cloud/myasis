import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'patchright';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';
import {specialistFixtureReply} from './specialist-fixture.js';
import {validToolInput} from './tool-input.js';

test('approved letter renders and uploads byte-exact without model transcription or an application send',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'owtomate-approved-letter-'));
 const keys=['DATA_DIR','CELERIS_API_KEY','CELERIS_QUEUE_FILE','CELERIS_MIN_INTERVAL_MS','APPLICATION_REVIEW_MODE','APPLICATION_AI_MODEL','APPROVED_APPLICATIONS_JSON','DRY_RUN','ALLOW_EXTERNAL_APPLY'];
 const prior=keys.map(k=>process.env[k]),originalFetch=globalThis.fetch;
 const job={id:'canonical-letter-fixture',title:'Fictional Analyst',company:'Example Fixture',location:'Sydney',platform:'indeed' as const,url:'https://letter.fixture.invalid/apply'};
 const text='Dear team,\n\nExact approved letter: café – SQL; no rewritten punctuation.\n\nRegards,\nAlex Fixture\n';
 const draft={id:'f67ea042-08f4-4a0a-b511-c0b30a876028',revision:'a'.repeat(64),job,preparedAt:new Date().toISOString(),formUrl:job.url,answers:[],coverLetter:text,resume:'CV.txt',resumeId:'cv',resumeHash:createHash('sha256').update('Fictional CV').digest('hex')};
 Object.assign(process.env,{DATA_DIR:dir,CELERIS_API_KEY:'fixture-only',CELERIS_QUEUE_FILE:join(dir,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',APPLICATION_REVIEW_MODE:'approved',APPLICATION_AI_MODEL:'celeris',APPROVED_APPLICATIONS_JSON:JSON.stringify([draft]),DRY_RUN:'true',ALLOW_EXTERNAL_APPLY:'true'});
 mkdirSync(join(dir,'resumes'));writeFileSync(join(dir,'resumes','CV.txt'),'Fictional CV');writeFileSync(join(dir,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt'}]));writeFileSync(join(dir,'approved-applications.json'),JSON.stringify([draft]));
 const {runAgentOnlyApplication}=await import('./agent-only.js');
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:'<main><h1>Fictional Analyst</h1><label>Cover letter<input id=letter type=file onchange="const file=this.files[0];file.text().then(text=>{document.querySelector(\'#received\').textContent=text;document.querySelector(\'#uploaded\').textContent=file.name;this.value=\'\';})"></label><p id=uploaded></p><pre id=received hidden></pre><button id=send onclick="window.sent=true">Submit</button></main>'}):route.abort());await page.goto(job.url);
  let turn=0,renderedFileId='';
  globalThis.fetch=(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));const specialist=specialistFixtureReply(body);if(specialist)return specialist;turn++;
   assert.ok(body.tools.some((t:any)=>t.function.name==='render_approved_cover_letter'));
   let call;
   if(turn===1){
    const action=body.tools.find((t:any)=>t.function.name==='browser_action').function.parameters;
    const batch=body.tools.find((t:any)=>t.function.name==='browser_batch').function.parameters;
    for(const command of [action,batch.properties.actions.items]){
     assert.ok(!command.properties.action.enum.includes('script'),'approved browser tools must not advertise rejected scripts');
     assert.equal(validToolInput({action:'script',script:'return document.title'},command),false);
     assert.equal(validToolInput({action:'click',selector:'#send',sends_application:false},command),true);
    }
    assert.equal(validToolInput({action:'dialog',value:'dismiss'},action),true,'dismissing a dialog remains available');
    assert.equal(validToolInput({action:'dialog',value:'accept'},action),false,'the contract excludes accepting dialogs');
    assert.match(action.properties.file_ids.description,/render_approved_cover_letter/);
    const schema=body.tools.find((t:any)=>t.function.name==='render_approved_cover_letter').function.parameters;
    assert.equal(schema.properties.text,undefined,'the model never has to transcribe the approved text');
    call={name:'render_approved_cover_letter',arguments:JSON.stringify({name:'Approved letter',format:'txt'})};
   }else if(turn===2){
    const rendered=JSON.parse(body.messages.filter((m:any)=>m.role==='tool').at(-1).content);
    assert.match(rendered.file_id,/^generated:/);
    assert.equal(rendered.role,'cover-letter');assert.equal(rendered.uploadable,true);
    assert.equal(rendered.native_upload_recorded,false,'rendering alone cannot claim an upload');
    assert.match(rendered.next_step,/Creating this file did not attach it/);
    assert.ok(rendered.next_step.includes(JSON.stringify([rendered.file_id])),'the handoff names the exact letter upload ID');
    renderedFileId=rendered.file_id;
    call={name:'browser_action',arguments:JSON.stringify({action:'set_input_files',selector:'#letter',file_ids:[rendered.file_id]})};
   }else{
    assert.equal(turn,3);
    await page.waitForFunction(()=>document.querySelector('#received')?.textContent?.startsWith('Dear team,'));
    const uploaded=await page.locator('#received').textContent();
    assert.equal(await page.locator('#letter').evaluate(node=>(node as HTMLInputElement).files!.length),0,'the employer widget clears its native file input after consuming the uploaded file');
    assert.equal(uploaded,text,'the actual browser receives the exact confirmed text');
    call={name:'finish',arguments:JSON.stringify({status:'skipped',reason:'Controlled fictional document transport verification complete.',evidence:'The fictional upload contains the exact approved letter.'})};
   }
   return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'canonical-'+turn,type:'function',function:call}]}}],usage:{prompt_tokens:50,completion_tokens:10}});
  }) as typeof fetch;
  const result=await runAgentOnlyApplication({simulation:'isolated-form',page,job,profile:{name:'Alex Fixture',skills:[]} as never,log:()=>{}});
  assert.equal(turn,3);assert.equal(result.coverLetter,text,'the uploaded canonical letter remains recorded for the approval comparison');assert.equal(result.submitPressed,false);assert.equal(await page.evaluate(()=>(window as any).sent??false),false);
  const {applicationApprovalGate}=await import('../application-review.js');
  const gate=async(context:Parameters<typeof applicationApprovalGate>[0])=>{
   const before=readFileSync(join(dir,'approved-applications.json'),'utf8');
   const decision=await applicationApprovalGate(context,page.locator('button').first());
   assert.equal(readFileSync(join(dir,'approved-applications.json'),'utf8'),before,'delivery checks and repairs never rewrite the candidate approval');
   return decision;
  };
  const expectRepair=(decision:Awaited<ReturnType<typeof gate>>)=>{
   assert.ok(decision?.kind==='ok'&&decision.disposition==='failed','observed changed content requests repair without replacing approval');
   assert.match(decision.message,/Restore.*approved/);
   assert.match(decision.message,/job remains approved; do not prepare it again/);
  };
  const digest=createHash('sha256').update((await page.locator('#received').textContent())!).digest('hex');
  const ctx={page,job,profile:{},observation:{},captured:result.captured,actions:[],log:()=>{},coverLetter:result.coverLetter,resumeUsed:'cv',resumeName:'CV.txt',
   uploadedDocuments:[{fileId:renderedFileId,sha256:digest,coverLetterDigest:digest}]} as never;
  assert.equal(await gate(ctx),null,'an unchanged uploaded approved letter must not become a false changed draft');
  await page.locator('#uploaded').evaluate(node=>{node.textContent='';});
  await page.locator('#received').evaluate(node=>{node.textContent='';});
  assert.equal(await gate({...ctx as object,coverLetter:undefined} as never),null,'completed native upload evidence survives a consumed FileList and absent body metadata');
  const missing={...ctx as object,coverLetter:undefined,uploadedDocuments:[]} as never;
  assert.equal(await gate(missing),null,'an approved letter does not require separate upload proof');
  assert.equal((missing as any).coverLetter,undefined,'passing the gate does not invent delivered letter text');
  assert.equal(await gate({...missing as object,coverLetter:text} as never),null);
  assert.equal(await gate({...missing as object,uploadedDocuments:[{fileId:renderedFileId,sha256:digest,coverLetterDigest:'wrong-source-digest'}]} as never),null,'incomplete delivery metadata cannot block an approved letter');

  const inlineDraft={...draft,answers:[{question:'Write a cover letter',answer:text}]};
  writeFileSync(join(dir,'approved-applications.json'),JSON.stringify([inlineDraft]));
  await page.setContent('<label>Write a cover letter<textarea id=body></textarea></label><button>Submit</button>');
  await page.locator('#body').fill(text);
  const witness={ref:'letter',label:'Write a cover letter',kind:'textarea' as const,required:false,currentValue:text};
  const inline={...ctx as any,captured:inlineDraft.answers,coverLetter:undefined,uploadedDocuments:[],letterWitness:[witness]};
  assert.equal(await gate(inline),null,'a matching current typed field proves an explicitly approved letter is present');
  await page.locator('#body').fill('Actually changed browser letter.');
  const alteredContext={...inline,captured:inlineDraft.answers,coverLetter:text};
  expectRepair(await gate(alteredContext));
  assert.equal(alteredContext.coverLetter,'Actually changed browser letter.','fresh current prose overrides stale authorization text');
  await page.locator('#body').fill('');
  const clearedContext={...inline,captured:inlineDraft.answers,coverLetter:text};
  assert.equal(await gate(clearedContext),null,'a blank optional letter does not reinstate the removed delivery guard');
  assert.equal(clearedContext.coverLetter,undefined,'a fresh empty field cannot inherit stale letter text');

  const legacy={...inlineDraft,coverLetter:undefined};
  writeFileSync(join(dir,'approved-applications.json'),JSON.stringify([legacy]));
  await page.locator('#body').fill(text);
  assert.equal(await gate({...inline,coverLetter:undefined}),null,'a matching current legacy textarea remains reusable');
  await page.locator('#body').fill('');
  assert.equal(await gate({...inline,coverLetter:text}),null,'legacy approved letters also proceed without delivery proof');
  await page.setContent('<p>The next wizard page contains no letter control.</p><button>Submit</button>');
  assert.equal(await gate({...inline,coverLetter:text}),null,'an absent wizard step retains an actual previous typed witness without treating absence as deletion');

  const optionalDraft={...draft,coverLetter:undefined,answers:[{question:'Additional context',answer:'Previously approved optional note.'}]};
  writeFileSync(join(dir,'approved-applications.json'),JSON.stringify([optionalDraft]));
  await page.setContent('<label>Additional context<input value=""></label><button>Submit</button>');
  const optionalContext={...ctx as any,captured:optionalDraft.answers,coverLetter:undefined,uploadedDocuments:[],letterWitness:undefined};
  assert.equal(await gate(optionalContext),null,'an ordinary optional note mismatch is advisory');
  assert.match(optionalContext.formAdvisories.join(' '),/Additional context/);
  writeFileSync(join(dir,'approved-applications.json'),JSON.stringify([draft]));
  const savedContext={...ctx as any,coverLetter:text,uploadedDocuments:[],letterWitness:undefined};
  await page.setContent('<form><input type="hidden" name="payload_3"><button>Submit</button></form>');
  await page.locator('input').evaluate((node,body)=>{(node as HTMLInputElement).value=body;},text);
  assert.equal(await gate(savedContext),null,'fresh enabled hidden form data can carry the approved letter on a saved review');
  await page.locator('input').evaluate(node=>{(node as HTMLInputElement).value='';});
  assert.equal(await gate(savedContext),null);
  await page.locator('input').evaluate((node,body)=>{(node as HTMLInputElement).value=body;(node as HTMLInputElement).disabled=true;},text);
  assert.equal(await gate(savedContext),null);
  await page.locator('input').evaluate(node=>{(node as HTMLInputElement).disabled=false;node.setAttribute('data-owtomate-private-auth','password');});
  assert.equal(await gate(savedContext),null);
  await page.locator('input').evaluate(node=>{node.removeAttribute('data-owtomate-private-auth');(node as HTMLInputElement).name='';});
  assert.equal(await gate(savedContext),null);
  await page.setContent('<form><fieldset disabled><input type="hidden" name="payload_3"></fieldset><button>Submit</button></form>');
  await page.locator('input').evaluate((node,body)=>{(node as HTMLInputElement).value=body;},text);
  assert.equal(await gate(savedContext),null);
  await page.setContent('<form id="unrelated"><input type="hidden" name="payload_3"></form><form><button>Submit</button></form>');
  await page.locator('input').evaluate((node,body)=>{(node as HTMLInputElement).value=body;},text);
  assert.equal(await gate(savedContext),null);
  await page.setContent('<input type="hidden" name="payload_3"><button>Submit</button>');
  await page.locator('input').evaluate((node,body)=>{(node as HTMLInputElement).value=body;},text);
  assert.equal(await gate(savedContext),null);
  assert.equal(savedContext.uploadedDocuments.length,0,'no hidden-form case fabricates upload evidence');
 }finally{globalThis.fetch=originalFetch;await browser.close();closeCelerisQueues();keys.forEach((k,i)=>prior[i]===undefined?delete process.env[k]:process.env[k]=prior[i]);rmSync(dir,{recursive:true,force:true});}
});
