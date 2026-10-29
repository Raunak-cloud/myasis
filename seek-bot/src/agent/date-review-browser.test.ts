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
type Body={messages:Array<{role:string;content:unknown}>;tools?:unknown[]};
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
    assert.match(observation(body), /DATE ACCURACY CHECKPOINT/);
    return [{ name: 'record_date_review', args: { assessment: 'ready', checks: [{ question: 'Employment start month', source_evidence: 'Candidate saved February 2024', intended_meaning: 'February 2024', observed_parts: '2024-02', conclusion: 'Matches saved source' }], next_action: 'Submit the current form' } }];
  }, () => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }],
  () => [{ name: 'finish', args: { status: 'applied', reason: 'Employer confirmed receipt.', evidence: 'Application received: FACT123', receipt: { quote: 'Application received: FACT123' } } }]];
  const sourcedDates = await runApplicationAgent({ page, job: { ...job, id: 'agent-owned-saved-date' }, profile, log: () => {} });
  assert.equal(sourcedDates.outcome.status, 'applied');
  assert.equal(await page.evaluate('window.factSends', undefined, undefined, false), 1);
  assert.equal(script.length, 0);
  await page.setContent('<main><form onsubmit="event.preventDefault();window.dateSends++;document.querySelector(\'main\').textContent=\'Application received: DATE123\'"><fieldset><legend>Available start date</legend><label>Month<input id=month></label><label>Day<input id=day></label><label>Year<input id=year></label></fieldset><button id=send>Submit</button></form></main>');
  await page.evaluate('window.dateSends=0', undefined, undefined, false);
  const review = (assessment: string) => ({ name: 'record_date_review', args: { assessment,
    checks: [{ question: 'Available start date', source_evidence: 'Synthetic candidate confirmed 1 November 2026', intended_meaning: '1 November 2026',
      observed_parts: assessment === 'correct' ? 'Month 1, Day 11, Year 2026' : 'Month 11, Day 1, Year 2026',
      conclusion: assessment === 'correct' ? 'Wrong: 11 January was filled; correct the component values' : 'Matches 1 November' }], next_action: assessment === 'correct' ? 'Correct the actual components' : 'Submit current form' } });
  script = [() => [{ name: 'browser_batch', args: { actions: [
    { action: 'fill', selector: '#month', value: '1' }, { action: 'fill', selector: '#day', value: '11' },
    { action: 'fill', selector: '#year', value: '2026' }, { action: 'click', selector: '#send', sends_application: true },
  ] } }], body => {
    assert.match(observation(body), /DATE ACCURACY CHECKPOINT/);
    assert.match(observation(body), /"label":"Month".*"value":"1"/);
    return [review('correct')];
  }, () => [{ name: 'browser_batch', args: { actions: [
    { action: 'fill', selector: '#month', value: '11' }, { action: 'fill', selector: '#day', value: '1' },
    { action: 'click', selector: '#send', sends_application: true },
  ] } }], body => {
    assert.match(observation(body), /DATE ACCURACY CHECKPOINT/);
    assert.match(observation(body), /"label":"Month".*"value":"11"/);
    return [review('ready')];
  }, () => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }],
  () => [{ name: 'finish', args: { status: 'applied', reason: 'Employer receipt after date correction', evidence: 'Application received: DATE123', receipt: { quote: 'Application received: DATE123' } } }]];
  const swappedDate = await runApplicationAgent({ page, job: { ...job, id: 'agent-owned-component-correction' }, profile, log: () => {} });
  assert.equal(swappedDate.outcome.status, 'applied');
  assert.equal(await page.evaluate('window.dateSends', undefined, undefined, false), 1, 'withheld sends are never replayed; only the reviewed final choice sends');
  assert.equal(script.length, 0);
  console.log('PASS: applying-agent date evidence, missing facts, corrected component readbacks and exactly one submission.');
}finally{await browser.close();rmSync(directory,{recursive:true,force:true});}
