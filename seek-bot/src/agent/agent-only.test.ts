import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { JobListing } from '../types.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-agent-only-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', FORM_CORPUS_DIR: join(directory, 'form-corpus'),
  ALLOW_EXTERNAL_APPLY: 'true', DRY_RUN: 'false', AGENT_BUDGET_USD: '0.10' });
process.env.APPLICATION_AI_MODEL = 'celeris';
writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: 'Availability', answer: 'Weekends only' }]));
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Private candidate CV evidence: pharmacy placement.');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv-1', label: 'Pharmacy CV', fileName: 'CV.txt', isDefault: true }]));
writeFileSync(join(directory, 'applied.json'), JSON.stringify([{ id: 'old-job', title: 'Prior role', platform: 'seek', appliedAt: new Date().toISOString() }]));

type Call = { name: string; args: Record<string, unknown> };
type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; output_config?: { effort?: string }; chat_template_kwargs?: { reasoning_effort?: string } };
let script: Array<(body: Body) => Call[]> = [];
const turns: Body[] = [];
let completionTokens = 10;
const observation = (body: Body) => JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content);
const reply = (calls: Call[]) => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({ id: `turn-${turns.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }], usage: { prompt_tokens: 30, completion_tokens: completionTokens } });
globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as Body;
  assert.ok(body.tools?.length, 'no independent checker, answerer, receipt verifier or script reviewer may be called');
  turns.push(body);
  const next = script.shift();
  assert.ok(next, 'the parent makes only the scripted number of requests');
  const response = reply(next(body));
  completionTokens = 10;
  return response;
}) as typeof fetch;
const { runApplicationAgent } = await import('./loop.js');
const { withApplicationAllowance } = await import('../application-allowance.js');
const { config } = await import('../config.js');
const { JOB_FIT_POLICY } = await import('../job-fit-policy.js');
const { reviewContextFingerprint, reviewContentFingerprint, applicationRejectionCache, ReviewCache } = await import('../review-cache.js');
const { outcomeFromRun } = await import('./outcome.js');
const { logOutcome } = await import('../store.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const context = await browser.newContext();
  const form = `<main><h1>Pharmacy Assistant</h1><form onsubmit="event.preventDefault();window.presses=(window.presses||0)+1;if(!document.querySelector('select').value){document.querySelector('#validation').textContent='Please choose a referral source';return}document.querySelector('main').innerHTML='<h1>Application received</h1><p>Receipt ABC123</p>'">
    <label>Name<input id=name></label><label>Email<input id=email></label>
    <label>Cover letter<textarea id=letter></textarea></label><label>Referral source<select><option value=''>Please select</option><option value=website>Company website</option></select></label>
    <input type=file id=cv><p class=generic-validation id=validation></p><button id=submit>Submit</button></form></main>`;
  await context.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid')
    ? route.fulfill({ contentType: 'text/html', body: form }) : route.abort());
  const page = await context.newPage();
  const url = 'https://careers.agent.invalid/apply';
  await page.goto(url);
  const job = { id: 'agent-only-retry', title: 'Pharmacy Assistant', company: 'Fixture Pharmacy', location: 'Sydney', url, applicationMode: 'external' } as JobListing;
  const profile = { name: 'Rinu Fixture', email: 'fixture@example.invalid', phone: '0400000000', skills: ['Customer service'], experienceSummary: 'Pharmacy placement', willingToRelocate: false } as never;
  const letter = 'Dear team,\n\nI would like to apply for the pharmacy assistant role.\n\nKind regards,\nRinu';
  script = [body => {
    const all = JSON.stringify(body);
    assert.match(all, /Rinu Fixture/); assert.match(all, /Weekends only/); assert.match(all, /pharmacy placement/);
    assert.match(all, /read_application_history/); // unrelated history is available on demand, not duplicated in every prompt
    return [
      { name: 'browser_action', args: { action: 'fill', locator: { by: 'label', value: 'Name' }, value: 'Rinu Fixture' } },
      { name: 'browser_action', args: { action: 'fill', locator: { by: 'label', value: 'Email' }, value: 'fixture@example.invalid' } },
      { name: 'browser_action', args: { action: 'fill', locator: { by: 'label', value: 'Cover letter' }, value: letter } },
      { name: 'upload_document', args: { locator: { by: 'css', value: '#cv' }, document_id: 'cv-1' } },
      { name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'button', name: 'Submit' }, sends_application: true } },
    ];
  }, body => {
    assert.match(observation(body), /Please choose a referral source/);
    assert.deepEqual(body.tools && (body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name).sort(), ['finish', 'resume_after_rejected_submission']);
    return [{ name: 'resume_after_rejected_submission', args: { evidence: 'Please choose a referral source' } }];
  }, () => [
    { name: 'browser_action', args: { action: 'select', locator: { by: 'role', value: 'combobox', name: 'Referral source' }, value: 'Company website' } },
    { name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } },
  ], body => {
    assert.match(observation(body), /Application received/); assert.match(observation(body), /ABC123/);
    return [{ name: 'finish', args: { status: 'applied', reason: 'Received after correcting referral source', evidence: 'Application received, Receipt ABC123', cover_letter: letter, resume_id: 'cv-1' } }];
  }];
  let quotaChecks = 0;
  const run = await withApplicationAllowance(async external => { assert.equal(external, true); quotaChecks++; return true; },
    () => runApplicationAgent({ page, job, profile, log: () => {} }));
  assert.equal(run.outcome.status, 'applied');
  assert.equal(await page.evaluate('window.presses', undefined, undefined, false), 2);
  assert.equal(run.coverLetter, letter); assert.equal(run.resumeUsed, 'cv-1'); assert.equal(run.submitPressed, true);
  assert.equal(script.length, 0); assert.equal(turns.length, 4); assert.equal(quotaChecks, 7);
  const effort = (body: Body) => body.chat_template_kwargs?.reasoning_effort;
  assert.equal(effort(turns[0]), 'medium'); assert.equal(effort(turns[2]), 'xhigh');
  assert.match(readFileSync(join(directory, 'traces', 'agent-only-retry.json'), 'utf8'), /ABC123/);
  assert.ok(existsSync(join(directory, 'form-corpus')), 'the sole agent retains private form replay recording');
  assert.equal(JSON.parse(readFileSync(join(directory, 'applied.json'), 'utf8')).length, 1, 'driver does not mutate history or reserve duplicate claims');

  await page.goto(url);

  const beforeBatch = turns.length;
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<input id=after>'), undefined, undefined, false);
  script = [body => {
    assert.doesNotMatch(JSON.stringify(body.tools), /fill_fields|answer_questions|review_saved_form/);
    return [{ name: 'browser_batch', args: { actions: [
      { action: 'fill', selector: '#name', value: 'Rinu Fixture' },
      { action: 'fill', selector: '#email', value: 'fixture@example.invalid' },
      { action: 'fill', selector: '#letter', value: letter },
      { action: 'select', selector: 'select', value: 'Company website' },
      { action: 'click', selector: '#submit', sends_application: true, wait: { locator: { by: 'text', value: 'Receipt ABC123' } } },
      { action: 'fill', selector: '#after', value: 'Never run after sending' },
    ] } }];
  }, body => {
    assert.match(observation(body), /Receipt ABC123/);
    return [{ name: 'finish', args: { status: 'applied', reason: 'Batched native actions received', evidence: 'Receipt ABC123' } }];
  }];
  const batched = await runApplicationAgent({ page, job: { ...job, id: 'agent-native-batch' }, profile, log: () => {} });
  assert.equal(batched.outcome.status, 'applied');
  assert.equal(turns.length-beforeBatch,2,'five native commands and receipt inspection need only two scripted model turns');
  assert.equal(await page.evaluate('window.presses',undefined,undefined,false),1);
  assert.equal(await page.inputValue('#after'), '', 'the remainder of a batch cannot mutate after a send before receipt review');
  assert.equal(batched.coverLetter,letter);
  assert.ok(batched.captured.some(answer=>answer.question.includes('Referral source') && answer.answer==='Company website'),'save the observed selected option for application history');
  const experience = readFileSync(join(directory,'site-hints.json'),'utf8');
  assert.match(experience,/fill/); assert.doesNotMatch(experience,/Rinu Fixture|fixture@example.invalid|Dear team/,'reusable approaches contain no candidate answers');

  await page.goto(url);
  await page.setContent(`<iframe id=login srcdoc="<label>Email<input type=email></label><label>Password<input type=password></label>"></iframe>`);
  process.env.SITE_AUTH_SECRET='synthetic-credential-secret';
  script=[()=>[{name:'complete_authentication',args:{targets:[{locator:{by:'label',value:'Email',frame:'#login'}},{locator:{by:'label',value:'Password',frame:'#login'}}],purpose:'create_account',reason:'Observed account registration inputs'}}],body=>{
    assert.match(JSON.stringify(body.messages),/authentication field\(s\) completed/);
    return [{name:'finish',args:{status:'skipped',reason:'Offline private authentication transport checked',evidence:'Both scoped iframe inputs filled using native browser events'}}];
  }];
  await runApplicationAgent({page,job:{...job,id:'native-private-auth'},profile,log:()=>{}});
  const privatePassword=await page.frameLocator('#login').getByLabel('Password').inputValue();
  assert.ok(privatePassword.length>=12);
  assert.equal(await page.frameLocator('#login').getByLabel('Email').inputValue(),'fixture@example.invalid');
  assert.equal(readFileSync(join(directory,'traces','native-private-auth.json'),'utf8').includes(privatePassword),false);
  delete process.env.SITE_AUTH_SECRET;

  await page.setContent('<label>Password<input id=password type=password></label>');
  script=[()=>[{name:'browser_action',args:{action:'fill',selector:'#password',value:'private-native-fixture'}}],body=>{
    assert.equal(JSON.stringify(body.messages.filter(message=>message.role==='tool')).includes('private-native-fixture'),false,'private readback never exposes the requested credential');
    return [{name:'finish',args:{status:'skipped',reason:'Offline native privacy check',evidence:'Native input filled without saving a reusable password answer'}}];
  }];
  const privateNative=await runApplicationAgent({page,job:{...job,id:'native-private-write'},profile,log:()=>{}});
  assert.equal(privateNative.captured.length,0,'private fields cannot become reusable candidate answers');

  await page.goto(url);
  await page.setContent(`<label>Name<input id=name></label><button id=stop type=button onclick="window.wrong=true">Next</button>`);
  script = [() => [{ name: 'browser_batch', args: { actions: [
    { action: 'fill', selector: '#name', value: 'Saved first' },
    { action: 'select', selector: '#name', value: 'Invalid widget action' },
    { action: 'click', selector: '#stop' },
  ] } }], body => {
    assert.match(JSON.stringify(body.messages), /remainingNotExecuted/);
    assert.equal(effort(body),'xhigh');
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Offline failure inspection', evidence: 'Batch stopped at the actual native error' } }];
  }];
  await runApplicationAgent({ page, job: { ...job,id:'batch-native-error' },profile,log:()=>{} });
  assert.equal(await page.inputValue('#name'),'Saved first');
  assert.equal(await page.evaluate('Boolean(window.wrong)',undefined,undefined,false),false);

  await page.goto(url);
  await page.setContent(`<label>Name<input id=name></label><p id=stage>Assessment question 8 of 8</p>`);
  let rejected = false;
  script = [() => [{ name:'save_progress',args:{ note:'Assessment question 8 of 8, do not restart.',answers:[{question:'Name',answer:'Saved candidate'}] } }], () => {
    rejected = true;
    throw new Error('CONTEXT_REJECTION_FIXTURE');
  }, body => {
    assert.match(observation(body),/Assessment question 8 of 8/);
    assert.match(observation(body),/Saved candidate/);
    return [{name:'browser_action',args:{action:'fill',selector:'#name',value:'Recovered in same live page'}}];
  }, () => [{name:'finish',args:{status:'skipped',reason:'Offline recovery complete',evidence:'Live question 8 and saved candidate retained'}}]];
  const normalFetch=globalThis.fetch;
  globalThis.fetch=(async (...args: Parameters<typeof fetch>)=> {
    try{return await normalFetch(...args);}catch(error){
      if((error as Error).message==='CONTEXT_REJECTION_FIXTURE')return new Response('maximum context length exceeded',{status:400});
      throw error;
    }
  }) as typeof fetch;
  const pageCount=context.pages().length;
  await runApplicationAgent({page,job:{...job,id:'native-context-recovery'},profile,log:()=>{}});
  globalThis.fetch=normalFetch;
  assert.equal(rejected,true); assert.equal(context.pages().length,pageCount);
  assert.equal(await page.inputValue('#name'),'Recovered in same live page');
  assert.equal(await page.locator('#stage').innerText(),'Assessment question 8 of 8');

  // The provider charges the final response before its tool calls dispatch.
  // A receipt already observed by Magnus must survive that budget boundary.
  await page.goto(url);
  await page.setContent(`<button id=send onclick="document.querySelector('main').textContent='Application received: BUDGET123'">Submit</button><main></main><input id=after>`);
  const beforeBudget = turns.length;
  script = [() => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }], body => {
    assert.match(observation(body), /Application received: BUDGET123/);
    assert.deepEqual((body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name).sort(), ['finish', 'resume_after_rejected_submission'], 'Housing-style receipt review cannot waste its final response on a wait for an already-matched URL');
    completionTokens = 1_000_000;
    return [
      { name: 'finish', args: { status: 'applied', reason: 'Employer accepted the application', evidence: 'Application received: BUDGET123' } },
      { name: 'browser_action', args: { action: 'fill', selector: '#after', value: 'Must not run after finish' } },
    ];
  }];
  const budgetReceipt = await runApplicationAgent({ page, job: { ...job, id: 'native-budget-receipt' }, profile, log: () => {} });
  assert.equal(budgetReceipt.outcome.status, 'applied');
  assert.equal(budgetReceipt.submitPressed, true);
  assert.equal(turns.length - beforeBudget, 2, 'no additional model call after the budget is exhausted');
  assert.equal(await page.inputValue('#after'), '');
  assert.match(readFileSync(join(directory, 'traces', 'native-budget-receipt.json'), 'utf8'), /BUDGET123/);

  await page.goto(url);
  await page.setContent(`<button id=send onclick="history.replaceState({},'', '/apply/success');document.querySelector('main').textContent='We could not process your application. Try later.'">Submit</button><main></main>`);
  script = [() => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }], body => {
    assert.match(observation(body), /could not process/);
    completionTokens = 1_000_000;
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Submission is unconfirmed', evidence: 'The URL says success but the actual employer response says it could not process the application.' } }];
  }];
  const uncertainReceipt = await runApplicationAgent({ page, job: { ...job, id: 'native-uncertain-receipt' }, profile, log: () => {} });
  assert.equal(uncertainReceipt.outcome.status, 'skipped', 'a success URL alone must not promote an unsuccessful application');
  assert.equal(uncertainReceipt.submitPressed, true, 'uncertain submissions retain duplicate protection');

  const finishApplied: Call = { name: 'finish', args: { status: 'applied', reason: 'Planned receipt', evidence: 'This claim must not bypass an unexecuted action' } };
  for (const [id, calls] of [
    ['mutation', [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }, finishApplied]],
    ['progress-write', [{ name: 'save_progress', args: { note: 'Must not be saved', cover_letter: 'Must not be recorded' } }, finishApplied]],
    ['invalid-finish', [{ name: 'finish', args: { status: 'applied' } }, finishApplied]],
  ] as Array<[string, Call[]]>) {
    await page.goto(url);
    await page.setContent(`<button id=send onclick="document.querySelector('main').textContent='Wrong receipt'">Submit</button><main>Not submitted</main>`);
    const before: number = turns.length;
    script = [() => { completionTokens = 1_000_000; return calls; }];
    const blocked = await runApplicationAgent({ page, job: { ...job, id: `native-budget-${id}` }, profile, log: () => {} });
    assert.deepEqual(blocked.outcome, { status: 'skipped', reason: 'The application spending budget was reached.' });
    assert.equal(blocked.submitPressed, false);
    assert.equal(blocked.coverLetter, undefined);
    assert.equal(await page.locator('main').innerText(), 'Not submitted');
    assert.equal(turns.length - before, 1, 'no generation or remaining plan actions after budget exhaustion');
  }

  process.env.APPLICATION_REVIEW_MODE = 'prepare';
  try {
    script = [() => { completionTokens = 1_000_000; return [finishApplied]; }];
    const unconfirmed = await runApplicationAgent({ page, job: { ...job, id: 'native-budget-semi-confirmation' }, profile, log: () => {} });
    assert.equal(unconfirmed.outcome.status, 'skipped', 'budget finalization still enforces Semi auto confirmation');
    assert.match(readFileSync(join(directory, 'traces', 'native-budget-semi-confirmation.json'), 'utf8'), /No application has been submitted/);
  } finally { delete process.env.APPLICATION_REVIEW_MODE; }

  script = [() => { completionTokens = 1_000_000; return [{ name: 'finish', args: {
    status: 'needs-human', reason: 'A required candidate fact is missing', evidence: 'Required availability question',
    questions: [{ question: 'Earliest start date', prompt: 'When can you start?', kind: 'text' }],
  } }]; }];
  const budgetQuestion = await runApplicationAgent({ page, job: { ...job, id: 'native-budget-question' }, profile, log: () => {} });
  assert.equal(budgetQuestion.outcome.status, 'needs-human', 'retain valid unanswered questions at the boundary too');
  if (budgetQuestion.outcome.status === 'needs-human') assert.equal(budgetQuestion.outcome.questions?.[0].question, 'Earliest start date');

  await page.goto(url);
  await page.setContent(`<label>Name<input id=name></label><button id=send onclick="document.querySelector('main').textContent='Application received: APPROVED123'">Submit</button><main></main>`);
  const reviewedJob: JobListing = { ...job, id: 'native-authoritative-match', description: 'Onsite Sydney application development.' };
  reviewedJob.fitReview = { score: 85, reason: 'The candidate matches these development duties', evidence: ['Relevant development'],
    contentFingerprint: reviewContentFingerprint(reviewedJob)!, contextFingerprint: reviewContextFingerprint(profile) };
  script = [body => {
    assert.match(JSON.stringify(body.messages), /APPROVED FIT REVIEW.*candidate matches these development duties/s);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Repeated assessment of the same title', evidence: 'Onsite Sydney application development.',
      fit_rejection: { source: 'listing', evidence: 'Onsite Sydney application development.' } } }];
  }, body => {
    assert.match(JSON.stringify(body.messages), /matcher already approved these unchanged listing facts/);
    return [{ name: 'browser_batch', args: { actions: [
      { action: 'fill', selector: '#name', value: 'Rinu Fixture' },
      { action: 'click', selector: '#send', sends_application: true },
    ] } }];
  }, () => [{ name: 'finish', args: { status: 'applied', reason: 'Approved job completed', evidence: 'Application received: APPROVED123' } }]];
  assert.equal((await runApplicationAgent({ page, job: reviewedJob, profile, log: () => {} })).outcome.status, 'applied', 'the applier cannot overturn unchanged approved listing facts');

  await page.setContent('<main>Current NV1 clearance must be held before applying.</main>');
  script = [() => [{ name: 'finish', args: { status: 'skipped', reason: 'The form introduced a mandatory clearance requirement', evidence: 'Current NV1 clearance must be held before applying.',
    fit_rejection: { source: 'form', evidence: 'Current NV1 clearance must be held before applying.' } } }]];
  const newRequirement = await runApplicationAgent({ page, job: reviewedJob, profile, log: () => {} });
  assert.equal(newRequirement.outcome.status, 'skipped', 'new mandatory form eligibility can still stop an approved match');
  assert.equal(applicationRejectionCache(reviewedJob, outcomeFromRun(newRequirement, reviewedJob.id, page.url()), reviewContextFingerprint(profile)), undefined, 'a form-only requirement is not cached against unchanged listing text');

  await page.goto(url);
  await page.setContent('<main>Role located in Melbourne VIC (Remote).</main>');
  const mismatchJob: JobListing = { ...job, id: 'native-late-fit-rejection', location: 'Melbourne VIC (Remote)', description: 'Fully remote software role in Melbourne.' };
  const contextFingerprint = reviewContextFingerprint(profile);
  script = [body => {
    assert.ok(body.messages.some(message => typeof message.content === 'string' && message.content.includes(JOB_FIT_POLICY)));
    assert.match(JSON.stringify(body.messages), /APPROVED FIT REVIEW\\nnull/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Actual arrangement conflicts with the saved onsite preference', evidence: 'Melbourne VIC (Remote)',
      fit_rejection: { source: 'listing', evidence: 'Melbourne VIC (Remote)' } } }];
  }];
  const lateMismatch = await runApplicationAgent({ page, job: mismatchJob, profile, log: () => {} });
  const mismatch = outcomeFromRun(lateMismatch, mismatchJob.id, page.url());
  const metadata = applicationRejectionCache(mismatchJob, mismatch, contextFingerprint);
  assert.equal(metadata?.disposition, 'fit-mismatch');
  logOutcome({ ...mismatch, title: mismatchJob.title, company: mismatchJob.company, reviewCache: metadata });
  const nextRun = new ReviewCache();
  assert.equal(nextRun.suppression(mismatchJob, contextFingerprint)?.disposition, 'fit-mismatch', 'a second run suppresses the actual application-stage mismatch');
  assert.equal(nextRun.suppression({ ...mismatchJob, description: 'Now onsite in Sydney.' }, contextFingerprint), null);
  const beforePreferences = config.rules.workArrangements;
  try {
    config.rules.workArrangements = ['remote'];
    assert.equal(nextRun.suppression(mismatchJob, reviewContextFingerprint(profile)), null, 'changed candidate preferences permit reconsideration');
  } finally { config.rules.workArrangements = beforePreferences; }

  await page.goto(url);
  script=[()=>[{name:'browser_action',args:{action:'fill',selector:'#name',value:'Must not happen'}}]];
  const quota=await withApplicationAllowance(()=>false,()=>runApplicationAgent({page,job:{...job,id:'native-quota'},profile,log:()=>{}}));
  assert.equal(quota.outcome.status,'skipped');assert.equal(await page.inputValue('#name'),'');

  await page.goto(url);
  await page.setContent('<main><iframe src="https://newassets.hcaptcha.com/captcha/v1/test/static/hcaptcha.html#frame=checkbox"></iframe></main>');
  const beforeCaptcha=turns.length;
  const captcha=await runApplicationAgent({page,job:{...job,id:'native-hcaptcha'},profile,log:()=>{}});
  assert.equal(captcha.outcome.status,'skipped');assert.equal(turns.length,beforeCaptcha,'visible hCaptcha stops before a model call');
  assert.equal(await page.locator('iframe').count(),1);
  console.log('PASS: native batched end-to-end submission, validation/context recovery, budget-boundary receipts without further actions or confirmation bypass, account allowance and immediate hCaptcha skip.');
} finally {
  await browser.close();
  rmSync(directory,{recursive:true,force:true});
}
