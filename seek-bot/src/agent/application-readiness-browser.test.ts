import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { JobListing } from '../types.js';
const directory = mkdtempSync(join(tmpdir(), 'agent-date-review-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', APPLICATION_AI_MODEL: 'celeris', DRY_RUN: 'false', ALLOW_EXTERNAL_APPLY: 'true', AGENT_BUDGET_USD: '0.20', FORM_CORPUS_DIR: join(directory,'corpus'), APPLICATION_REVIEW_MODE: '', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false' });
mkdirSync(join(directory,'resumes'));
writeFileSync(join(directory,'resumes/CV.txt'),'Alex Fixture. Software developer.');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv-1',label:'Fictional CV',fileName:'CV.txt'}]));
writeFileSync(join(directory,'answers.json'),'[]');
type Call={name:string;args:Record<string,unknown>};
type Body={messages:Array<{role:string;content:unknown}>;tools?:unknown[];chat_template_kwargs?:{reasoning_effort?:string}};
let script:Array<(body:Body)=>Call[]>=[];
let turn=0;
const observation=(body:Body)=>{const content=body.messages.filter(message=>message.role==='user').at(-1)?.content;return typeof content==='string'?content:JSON.stringify(content);};
globalThis.fetch=(async(_url,init)=>{
 const body=JSON.parse(String(init?.body)) as Body;
 assert.ok(body.tools?.length,'only the applying agent decides; no extra reviewer');
 const next=script.shift();assert.ok(next,'no unexpected model request');
 return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:next(body).map((call,index)=>({id:`date-${turn++}-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))}}],usage:{prompt_tokens:30,completion_tokens:10}});
}) as typeof fetch;
const {runApplicationAgent}=await import('./loop.js');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
try {
 const context=await browser.newContext();
 await context.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:'<main>Fixture</main>'}):route.abort());
 const page=await context.newPage();
 const url='https://employer.date.invalid/apply';await page.goto(url);
 const job={id:'date-fixture',title:'Software Developer',company:'Fictional employer',location:'Sydney',url,applicationMode:'external'} as JobListing;
 const profile={name:'Alex Fixture',email:'fixture@example.invalid',skills:['TypeScript'],willingToRelocate:false} as never;
  // The applying agent retrieves evidence and chooses whether to ask or send.
  // The fetch mock rejects any unexpected reviewer call; no fact-review model is hidden in tools.
  const personalForm = '<main><form onsubmit="event.preventDefault();window.factSends++;document.querySelector(\'main\').textContent=\'Application received: FACT123\'"><label>Employment start month<input id=date type=month required></label><button id=send>Submit application</button></form></main>';
  await page.setContent(personalForm); await page.evaluate('window.factSends=0', undefined, undefined, false);
  script = [body => {
    assert.match(String(body.messages[0].content), /You own personal-answer verification/);
    assert.match(String(body.messages[0].content), /duration such as two years does not establish exact start\/end months/);
    return [{ name: 'read_candidate_evidence', args: { query: 'employment dates' } }];
  }, body => {
    assert.match(JSON.stringify(body.messages), /OWNER-SCOPED CANDIDATE EVIDENCE/);
    return [{ name: 'finish', args: { status: 'needs-human', reason: 'Exact start month is not in saved evidence.',
      evidence: 'The form requires Employment start month.', questions: [{ question: 'Employment start month', prompt: 'What month and year did this role start?', kind: 'text' }] } }];
  }];
  const missingDates = await runApplicationAgent({ page, job: { ...job, id: 'agent-owned-unknown-date' }, profile, log: () => {} });
  assert.equal(missingDates.outcome.status, 'needs-human');
  assert.equal(await page.evaluate('window.factSends', undefined, undefined, false), 0);
  assert.equal(script.length, 0);
  writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: 'Employment start month', answer: 'February 2024' }]));
  script = [() => [{ name: 'read_candidate_evidence', args: { query: 'employment dates' } }], body => {
    assert.match(JSON.stringify(body.messages), /February 2024/);
    return [{ name: 'browser_action', args: { action: 'fill', selector: '#date', value: '2024-02' } }];
  }, () => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }],
  body => {
    assert.match(observation(body), /APPLICATION ACCURACY CHECKPOINT/);
    return [{ name: 'record_application_review', args: { assessment: 'ready', vacancy: 'Software Developer at Fictional employer, Sydney', documents: 'Fixture requires no documents', unresolved: [], checks: [{ question: 'Employment start month', source_evidence: 'Candidate saved February 2024', intended_meaning: 'February 2024', observed_value: '2024-02', conclusion: 'Matches saved source' }], next_action: 'Submit the current form' } }];
  }, () => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }],
  () => [{ name: 'finish', args: { status: 'applied', reason: 'Employer confirmed receipt.', evidence: 'Application received: FACT123', receipt: { quote: 'Application received: FACT123' } } }]];
  const sourcedDates = await runApplicationAgent({ page, job: { ...job, id: 'agent-owned-saved-date' }, profile, log: () => {} });
  assert.equal(sourcedDates.outcome.status, 'applied');
  assert.equal(await page.evaluate('window.factSends', undefined, undefined, false), 1);
  assert.equal(script.length, 0);
  await page.setContent('<main><form onsubmit="event.preventDefault();window.dateSends++;document.querySelector(\'main\').textContent=\'Application received: DATE123\'"><fieldset><legend>Available start date</legend><label>Month<input id=month></label><label>Day<input id=day></label><label>Year<input id=year></label></fieldset><button id=send>Submit</button></form></main>');
  await page.evaluate('window.dateSends=0', undefined, undefined, false);
  const review = (assessment: string) => ({ name: 'record_application_review', args: { assessment, vacancy: 'Software Developer at Fictional employer, Sydney', documents: 'Fixture requires no documents', unresolved: [],
    checks: [{ question: 'Available start date', source_evidence: 'Synthetic candidate confirmed 1 November 2026', intended_meaning: '1 November 2026',
      observed_value: assessment === 'correct' ? 'Month 1, Day 11, Year 2026' : 'Month 11, Day 1, Year 2026',
      conclusion: assessment === 'correct' ? 'Wrong: 11 January was filled; correct the component values' : 'Matches 1 November' }], next_action: assessment === 'correct' ? 'Correct the actual components' : 'Submit current form' } });
  script = [() => [{ name: 'browser_batch', args: { actions: [
    { action: 'fill', selector: '#month', value: '1' }, { action: 'fill', selector: '#day', value: '11' },
    { action: 'fill', selector: '#year', value: '2026' }, { action: 'click', selector: '#send', sends_application: true },
  ] } }], body => {
    assert.match(observation(body), /APPLICATION ACCURACY CHECKPOINT/);
    assert.match(observation(body), /"label":"Month".*"value":"1"/);
    return [review('correct')];
  }, body => {
    assert.equal(body.chat_template_kwargs?.reasoning_effort, 'xhigh', 'agent-authored correction keeps high effort while executing the repair');
    return [{ name: 'browser_batch', args: { actions: [
    { action: 'fill', selector: '#month', value: '11' }, { action: 'fill', selector: '#day', value: '1' },
    { action: 'click', selector: '#send', sends_application: true },
  ] } }]; }, body => {
    assert.match(observation(body), /APPLICATION ACCURACY CHECKPOINT/);
    assert.match(observation(body), /"label":"Month".*"value":"11"/);
    return [review('ready')];
  }, () => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }],
  () => [{ name: 'finish', args: { status: 'applied', reason: 'Employer receipt after date correction', evidence: 'Application received: DATE123', receipt: { quote: 'Application received: DATE123' } } }]];
  const swappedDate = await runApplicationAgent({ page, job: { ...job, id: 'agent-owned-component-correction' }, profile, log: () => {} });
  assert.equal(swappedDate.outcome.status, 'applied');
  assert.equal(await page.evaluate('window.dateSends', undefined, undefined, false), 1, 'withheld sends are never replayed; only the reviewed final choice sends');
  assert.equal(script.length, 0);
  await page.setContent('<main><form onsubmit="event.preventDefault();window.noticeSends++"><label>Current notice period<select required><option>2 weeks</option><option>4 weeks</option></select></label><button>Submit application</button></form></main>');
  await page.evaluate('window.noticeSends=0', undefined, undefined, false);
  writeFileSync(join(directory, 'answers.json'), JSON.stringify([{question:'Current notice period',answer:'One week only; no alternative is authorized.'}]));
  script = [body => {
    assert.match(String(body.messages[0].content), /a nearest available choice is not an authorized substitute/);
    return [{name:'read_candidate_evidence',args:{query:'notice period'}}];
  }, body => {
    assert.match(JSON.stringify(body.messages), /One week only/);
    return [{name:'finish',args:{status:'needs-human',reason:'Required dropdown has no truthful option for confirmed one week.',evidence:'Only 2 weeks and 4 weeks are offered.',questions:[{question:'Current notice period',prompt:'The form offers only 2 weeks or 4 weeks. Is either an authorized alternative?',kind:'text'}]}}];
  }];
  const unsupportedNotice = await runApplicationAgent({page,job:{...job,id:'agent-owned-unsupported-notice'},profile,log:()=>{}});
  assert.equal(unsupportedNotice.outcome.status,'needs-human');
  assert.equal(await page.evaluate('window.noticeSends',undefined,undefined,false),0);
  assert.equal(script.length,0);
  // No date controls: an unsupported parsed answer must still reach self-review.
  await page.setContent('<main><form onsubmit="event.preventDefault();window.factSends++;document.querySelector(\'main\').textContent=\'Application received: HISTORY123\'"><label>Previously employed here?<select id=history><option>Yes</option><option>No</option></select></label><button id=send>Submit application</button></form></main>');
  await page.evaluate('window.factSends=0',undefined,undefined,false);
  writeFileSync(join(directory,'answers.json'),JSON.stringify([{question:'Previously employed here?',answer:'No, never employed by the fictional employer.'}]));
  const historyReview = (assessment: string, unresolved: string[] = []) => ({ name:'record_application_review',args:{assessment,
    vacancy:'Software Developer at Fictional employer, Sydney',documents:'No documents required by fixture',unresolved,
    checks:[{question:'Previously employed here?',source_evidence:'Saved answer: No, never employed by the fictional employer.',intended_meaning:'No',observed_value:assessment==='correct'?'Yes':'No',conclusion:assessment==='correct'?'Parsed answer conflicts; correct it':'Matches confirmed source'}],next_action:assessment==='correct'?'Select No and inspect':'Send the reviewed form'}});
  script=[()=>[{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],body=>{
    assert.match(observation(body),/APPLICATION ACCURACY CHECKPOINT/);
    assert.match(observation(body),/Previously employed here/);
    return [historyReview('ready',['Employer history conflicts'])];
  },body=>{
    assert.match(JSON.stringify(body.messages),/Resolve the listed conflicts/);
    return [historyReview('correct')];
  },()=>[{name:'browser_batch',args:{actions:[{action:'select',selector:'#history',value:'No'},{action:'click',selector:'#send',sends_application:true}]}}],
  ()=>[historyReview('ready')],()=>[{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],
  ()=>[{name:'finish',args:{status:'applied',reason:'Employer receipt',evidence:'Application received: HISTORY123',receipt:{quote:'Application received: HISTORY123'}}}]];
  const historyResult=await runApplicationAgent({page,job:{...job,id:'ordinary-answer-review'},profile,log:()=>{}});
  assert.equal(historyResult.outcome.status,'applied');assert.equal(script.length,0);
  assert.equal(await page.evaluate('window.factSends',undefined,undefined,false),1,'conflicting ready did not send; correction was checked before one actual send');
  await page.setContent('<main><form onsubmit="event.preventDefault();window.tagSends++;document.querySelector(\'main\').textContent=\'Application received: TAG123\'"><label>Work environment<input id=environment role=combobox aria-required=true aria-controls=chosen></label><ul id=chosen role=listbox aria-multiselectable=true><li role=option aria-selected=true>On Site</li></ul><button id=send>Submit application</button></form></main>');
  await page.evaluate('window.tagSends=0',undefined,undefined,false);
  let tagReviews=0;
  script=[()=>[{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],body=>{
    tagReviews++;assert.match(observation(body),/APPLICATION ACCURACY CHECKPOINT/);
    assert.match(observation(body),/On Site/);
    return [{name:'record_application_review',args:{assessment:'ready',vacancy:'Fictional employer Software Developer Sydney',documents:'Fixture needs no documents',unresolved:[],checks:[{question:'Work environment',source_evidence:'Fictional candidate confirmed onsite Sydney',intended_meaning:'On Site',observed_value:'Committed On Site tag, empty search input',conclusion:'Selection is committed; search text is not the saved answer'}],next_action:'Choose Submit'}}];
  },()=>[{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],
  ()=>[{name:'finish',args:{status:'applied',reason:'Employer receipt',evidence:'Application received: TAG123',receipt:{quote:'Application received: TAG123'}}}]];
  const tagged=await runApplicationAgent({page,job:{...job,id:'canonical-tag-review'},profile,log:()=>{}});
  assert.equal(tagged.outcome.status,'applied');assert.equal(script.length,0);assert.equal(tagReviews,1,'empty search input cannot trigger repeated review of an unchanged committed tag');
  assert.equal(await page.evaluate('window.tagSends',undefined,undefined,false),1);
  console.log('PASS: applying-agent source review, dates, unsupported facts, canonical tag readback and exactly-once submission.');
}finally{await browser.close();rmSync(directory,{recursive:true,force:true});}
