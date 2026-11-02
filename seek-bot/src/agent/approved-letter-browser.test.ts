import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'patchright';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';
import {specialistFixtureReply} from './specialist-fixture.js';

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
  let turn=0;
  globalThis.fetch=(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));const specialist=specialistFixtureReply(body);if(specialist)return specialist;turn++;
   assert.ok(body.tools.some((t:any)=>t.function.name==='render_approved_cover_letter'));
   let call;
   if(turn===1){
    const schema=body.tools.find((t:any)=>t.function.name==='render_approved_cover_letter').function.parameters;
    assert.equal(schema.properties.text,undefined,'the model never has to transcribe the approved text');
    call={name:'render_approved_cover_letter',arguments:JSON.stringify({name:'Approved letter',format:'txt'})};
   }else if(turn===2){
    const rendered=JSON.parse(body.messages.filter((m:any)=>m.role==='tool').at(-1).content);
    assert.match(rendered.file_id,/^generated:/);
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
  const ctx={page,job,profile:{},observation:{},captured:result.captured,actions:[],log:()=>{},coverLetter:result.coverLetter,resumeUsed:'cv',resumeName:'CV.txt'} as never;
  assert.equal(await applicationApprovalGate(ctx),null,'an unchanged uploaded approved letter must not become a false changed draft');
  await page.locator('#uploaded').evaluate(node=>{node.textContent='';});
  await page.locator('#received').evaluate(node=>{node.textContent='';});
  const missing={...ctx as object,coverLetter:undefined} as never;
  const missingResult=await applicationApprovalGate(missing);
  assert.ok(missingResult?.kind==='terminal'&&missingResult.outcome.status==='prepared','missing recorded delivery cannot be supplied from authorization text alone');
  assert.equal(missingResult.outcome.draft.coverLetter,undefined);

  const inlineDraft={...draft,answers:[{question:'Write a cover letter',answer:text}]};
  writeFileSync(join(dir,'approved-applications.json'),JSON.stringify([inlineDraft]));
  await page.setContent('<label>Write a cover letter<textarea id=body></textarea></label><button>Submit</button>');
  await page.locator('#body').fill(text);
  const witness={ref:'letter',label:'Write a cover letter',kind:'textarea' as const,required:false,currentValue:text};
  const inline={...ctx as any,captured:inlineDraft.answers,coverLetter:undefined,letterWitness:[witness]};
  assert.equal(await applicationApprovalGate(inline),null,'a matching current typed field proves an explicitly approved letter is present');
  await page.locator('#body').fill('Actually changed browser letter.');
  const altered=await applicationApprovalGate({...inline,captured:inlineDraft.answers,coverLetter:text});
  assert.ok(altered?.kind==='terminal'&&altered.outcome.status==='prepared','current changed prose cannot inherit the previous approval');
  assert.equal(altered.outcome.draft.coverLetter,'Actually changed browser letter.','the new draft records the actual current prose rather than authorization text');
  assert.equal(altered.outcome.draft.answers[0].answer,'Actually changed browser letter.');
  await page.locator('#body').fill('');
  const cleared=await applicationApprovalGate({...inline,captured:inlineDraft.answers,coverLetter:text});
  assert.ok(cleared?.kind==='terminal'&&cleared.outcome.status==='prepared','an observed empty optional control overrides retained text and old typed evidence');
  assert.equal(cleared.outcome.draft.coverLetter,undefined);
  assert.deepEqual(cleared.outcome.draft.answers,[],'fresh empty fields remove the stale captured answer');

  const legacy={...inlineDraft,coverLetter:undefined};
  writeFileSync(join(dir,'approved-applications.json'),JSON.stringify([legacy]));
  await page.locator('#body').fill(text);
  assert.equal(await applicationApprovalGate({...inline,coverLetter:undefined}),null,'a matching current legacy textarea remains reusable');
  await page.locator('#body').fill('');
  const legacyClear=await applicationApprovalGate({...inline,coverLetter:text});
  assert.ok(legacyClear?.kind==='terminal'&&legacyClear.outcome.status==='prepared','cleared legacy prose cannot be restored from a stale witness');
  assert.equal(legacyClear.outcome.draft.coverLetter,undefined);
  await page.setContent('<p>The next wizard page contains no letter control.</p><button>Submit</button>');
  assert.equal(await applicationApprovalGate({...inline,coverLetter:text}),null,'an absent wizard step retains an actual previous typed witness without treating absence as deletion');

  const optionalDraft={...draft,coverLetter:undefined,answers:[{question:'Additional context',answer:'Previously approved optional note.'}]};
  writeFileSync(join(dir,'approved-applications.json'),JSON.stringify([optionalDraft]));
  await page.setContent('<label>Additional context<input value=""></label><button>Submit</button>');
  const emptyOptional=await applicationApprovalGate({...ctx as any,captured:optionalDraft.answers,coverLetter:undefined,letterWitness:undefined});
  assert.ok(emptyOptional?.kind==='terminal'&&emptyOptional.outcome.status==='prepared','fresh blank non-letter fields also invalidate captured prior answers');
  assert.deepEqual(emptyOptional.outcome.draft.answers,[]);
 }finally{globalThis.fetch=originalFetch;await browser.close();closeCelerisQueues();keys.forEach((k,i)=>prior[i]===undefined?delete process.env[k]:process.env[k]=prior[i]);rmSync(dir,{recursive:true,force:true});}
});
