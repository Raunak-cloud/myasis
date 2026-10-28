import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { JobListing } from '../types.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-agent-only-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', FORM_CORPUS_DIR: join(directory, 'form-corpus'),
  ALLOW_EXTERNAL_APPLY: 'true', DRY_RUN: 'false', AGENT_BUDGET_USD: '0.10', AGENT_PROGRESS_BUDGET_USD: '0.50' });
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
  assert.ok(body.tools?.length, 'only the applying agent may decide submission and receipt');
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
    assert.match(all, /MATCHING-STAGE DUPLICATE DECISION/);
    assert.match(all, /read_application_attempts/);
    assert.doesNotMatch(JSON.stringify(body.tools), /read_application_history/);
    return [
      { name: 'browser_action', args: { action: 'fill', locator: { by: 'label', value: 'Name' }, value: 'Rinu Fixture' } },
      { name: 'browser_action', args: { action: 'fill', locator: { by: 'label', value: 'Email' }, value: 'fixture@example.invalid' } },
      { name: 'browser_action', args: { action: 'fill', locator: { by: 'label', value: 'Cover letter' }, value: letter } },
      { name: 'browser_action', args: { action: 'set_input_files', locator: { by: 'css', value: '#cv' }, file_ids: ['cv-1'] } },
      { name: 'save_progress', args: { note: 'Selected resume attached.', resume_id: 'cv-1' } },
      { name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'button', name: 'Submit' }, sends_application: true, wait: { timeout_ms: 5000 } } },
    ];
  }, body => {
    assert.doesNotMatch(JSON.stringify(body.messages.filter(message => message.role === 'tool')), /Browser\/tool error:/,
      'a timeout-only post-action wait must not report an executed submit as a selector failure');
    assert.match(observation(body), /Please choose a referral source/);
    assert.deepEqual(body.tools && (body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name).sort(), ['finish', 'resume_after_rejected_submission', 'take_snapshot', 'wait_for_submission_result']);
    return [{ name: 'resume_after_rejected_submission', args: { evidence: 'Please choose a referral source' } }];
  }, () => [
    { name: 'browser_action', args: { action: 'select', locator: { by: 'role', value: 'combobox', name: 'Referral source' }, value: 'Company website' } },
    { name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true, wait: { selector: '#never-arrives', timeout_ms: 20 } } },
  ], body => {
    assert.doesNotMatch(JSON.stringify(body.messages.filter(message => message.role === 'tool')), /Browser\/tool error:/);
    assert.match(JSON.stringify(body.messages), /action completed, but its follow-up wait timed out/);
    assert.match(observation(body), /Application received/); assert.match(observation(body), /ABC123/);
    return [{ name: 'finish', args: { status: 'applied', reason: 'Received after correcting referral source', evidence: 'Application received, Receipt ABC123', receipt: { quote: 'Application received' }, cover_letter: letter, resume_id: 'cv-1' } }];
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

  // Exercise the real loop across a small normal turn boundary. A completed
  // browser field earns the extension; model-authored notes alone do not.
  const normalSteps = config.celeris.maxSteps, progressSteps = config.celeris.progressMaxSteps;
  try {
    config.celeris.maxSteps = 3; config.celeris.progressMaxSteps = 8;
    await page.goto(url);
    script = [
      () => [{ name: 'browser_action', args: { action: 'fill', selector: '#name', value: 'Rinu Fixture' } }],
      () => [{ name: 'save_progress', args: { note: 'The name is filled.' } }],
      () => [{ name: 'browser_action', args: { action: 'fill', selector: '#email', value: 'fixture@example.invalid' } }],
      () => [{ name: 'browser_action', args: { action: 'select', selector: 'select', value: 'Company website' } }],
      () => [{ name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } }],
      body => {
        assert.match(observation(body), /Application received/);
        return [{ name: 'finish', args: { status: 'applied', reason: 'Completed after verified progress', evidence: 'Application received, Receipt ABC123', receipt: { quote: 'Application received' } } }];
      },
    ];
    const extended = await runApplicationAgent({ page, job: { ...job, id: 'progress-turn-extension' }, profile, log: () => {} });
    assert.equal(extended.outcome.status, 'applied');
    assert.equal(extended.steps, 6);
    assert.equal(script.length, 0);
    assert.equal(await page.evaluate('window.presses', undefined, undefined, false), 1, 'one send beyond the normal boundary, one confirmed receipt');

    await page.goto(url);
    script = Array.from({ length: 3 }, () => () => [{ name: 'save_progress', args: { note: 'I claim to be making progress.' } }]);
    const unchanged = await runApplicationAgent({ page, job: { ...job, id: 'no-turn-extension-for-notes' }, profile, log: () => {} });
    assert.equal(unchanged.outcome.status, 'skipped');
    assert.equal(unchanged.steps, 3);
    assert.equal(unchanged.submitPressed, false);
    assert.equal(script.length, 0);

    await page.setContent(`<main>${Array.from({ length: 8 }, (_, index) => `<label>Question ${index}<input id="answer-${index}"></label>`).join('')}</main>`);
    script = Array.from({ length: 8 }, (_, index) => () => [{ name: 'browser_action', args: { action: 'fill', selector: `#answer-${index}`, value: 'Fixture answer' } }]);
    const capped = await runApplicationAgent({ page, job: { ...job, id: 'progress-turn-hard-cap' }, profile, log: () => {} });
    assert.equal(capped.outcome.status, 'skipped');
    assert.equal(capped.steps, 8, 'even genuine progress cannot generate beyond the configured hard cap');
    assert.equal(capped.submitPressed, false);
    assert.equal(script.length, 0);
  } finally { config.celeris.maxSteps = normalSteps; config.celeris.progressMaxSteps = progressSteps; }

  // A genuine small PDF, without office software or network access. Conversion
  // selection uses a prebuilt variant; the production converter is unchanged.
  const pdfObjects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 47 >>\nstream\nBT /F1 12 Tf 20 250 Td (Synthetic resume) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  pdfObjects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(join(directory, 'resumes', 'CV.pdf'), pdf);
  const originalInventory = readFileSync(join(directory, 'resumes.json'), 'utf8');
  writeFileSync(join(directory, 'resumes.json'), JSON.stringify([
    ...JSON.parse(originalInventory), { id: 'cv-pdf', label: 'Synthetic PDF CV', fileName: 'CV.pdf' },
  ]));
  const uploadForm = (accept: string) => `<main><form onsubmit="event.preventDefault();if(!document.querySelector('#resume').files.length)return;window.lastUploaded=document.querySelector('#resume').files[0];window.otherFileCount=document.querySelector('#unused').files.length;document.querySelector('main').textContent='Application received: UPLOAD123'">
    <label>Unused attachment<input type=file id=unused accept='image/*'></label>
    <section id=resume-section><label>Resume<input type=file id=resume accept='${accept}' onchange="window.uploadChanges=(window.uploadChanges||0)+1"></label></section>
    <button id=send>Submit</button></form></main>`;
  for (const [index, accept] of ['doc,docx,pdf,rtf', '.pdf', 'application/pdf', 'unrecognised-format-hint'].entries()) {
    await page.setContent(uploadForm(accept));
    await page.evaluate('window.uploadChanges=0', undefined, undefined, false);
    const before: number = turns.length;
    script = [() => [{ name: 'browser_action', args: { action: 'set_input_files', file_ids: ['cv-pdf'], locator: { by: 'label', value: 'Resume', within: '#resume-section' } } },
      { name: 'save_progress', args: { note: 'Original PDF attachment verified.', resume_id: 'cv-pdf' } }], body => {
      assert.match(JSON.stringify(body.messages), /CV.pdf/);
      return [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }];
    }, body => {
      assert.match(observation(body), /Application received: UPLOAD123/);
      return [{ name: 'finish', args: { status: 'applied', reason: 'Native attachment accepted by fixture', evidence: 'Application received: UPLOAD123', receipt: { quote: 'Application received: UPLOAD123' } } }];
    }];
    const uploaded = await runApplicationAgent({ page, job: { ...job, id: `direct-upload-${index}` }, profile, log: () => {} });
    assert.equal(uploaded.outcome.status, 'applied');
    assert.equal(uploaded.resumeUsed, 'cv-pdf');
    assert.equal(turns.length - before, 3, 'one native upload, one send and one receipt judgement; no format gate or independent reviewer');
    assert.equal(await page.evaluate('window.uploadChanges', undefined, undefined, false), 1, 'native upload dispatches the actual file change event');
    assert.equal(await page.evaluate('window.otherFileCount', undefined, undefined, false), 0, 'only the agent-selected upload target receives a file');
    const uploadedBytes = await page.evaluate('(async () => Array.from(new Uint8Array(await window.lastUploaded.arrayBuffer())))()', undefined, undefined, false);
    assert.deepEqual(Buffer.from(uploadedBytes as number[]), Buffer.from(pdf), 'the original PDF bytes are uploaded unchanged');
  }

  await page.setContent(`<main><label>Resume<input type=file id=resume accept='doc,docx,pdf,rtf' onchange="document.querySelector('#message').textContent=this.files[0].name.endsWith('.pdf')?'Resume accepted':'Only PDF accepted by this employer'"></label><p id=message></p><button id=send onclick="if(document.querySelector('#message').textContent==='Resume accepted')document.querySelector('main').textContent='Application received: CONVERT123'">Submit</button></main>`);
  script = [() => [{ name: 'browser_action', args: { action: 'set_input_files', file_ids: ['cv-1'], selector: '#resume' } }], body => {
    assert.match(observation(body), /Only PDF accepted by this employer/);
    assert.match(JSON.stringify(body.messages), /CV.txt/, 'the original must be attempted unchanged, not silently converted from accept');
    return [{ name: 'convert_file', args: { file_id: 'cv-1', format: 'pdf' } }];
  }, body => {
    const result = JSON.parse(String(body.messages.filter(message => message.role === 'tool').at(-1)?.content));
    return [{ name: 'browser_action', args: { action: 'set_input_files', file_ids: [result.file_id], selector: '#resume' } }];
  }, body => {
    assert.match(observation(body), /Resume accepted/);
    assert.match(JSON.stringify(body.messages), /CV.pdf/);
    return [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }];
  }, () => [{ name: 'finish', args: { status: 'applied', reason: 'Agent chose PDF after actual employer rejection', evidence: 'Application received: CONVERT123', receipt: { quote: 'Application received: CONVERT123' } } }]];
  const convertedUpload = await runApplicationAgent({ page, job: { ...job, id: 'agent-requested-upload-format' }, profile, log: () => {} });
  assert.equal(convertedUpload.outcome.status, 'applied');

  await page.setContent(uploadForm('doc,docx,pdf,rtf'));
  script = [() => [{ name: 'browser_action', args: { action: 'set_input_files', file_ids: ['../../another-account/CV.pdf'], selector: '#resume' } }], body => {
    assert.match(JSON.stringify(body.messages), /Choose a file ID from the candidate document inventory/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Unknown document correctly refused', evidence: 'No account-owned document matched that ID' } }];
  }];
  await runApplicationAgent({ page, job: { ...job, id: 'direct-upload-owner-isolation' }, profile, log: () => {} });
  assert.equal(await page.locator('#resume').evaluate(input => (input as HTMLInputElement).files?.length), 0);
  writeFileSync(join(directory, 'resumes.json'), originalInventory);

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
    return [{ name: 'finish', args: { status: 'applied', reason: 'Batched native actions received', evidence: 'Receipt ABC123', receipt: { quote: 'Application received' } } }];
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

  // Expensive scripted replies exercise the actual browser, observations,
  // batched action gates and shared meter without billing a real AI provider.
  config.celeris.budgetUsdPerApplication = 0.20;
  const expensive = (calls: Call[]) => { completionTokens = 100_000; return calls; };
  const progressForm = `<main>${Array.from({ length: 9 }, (_, i) => `<label>Question ${i}<input id=q${i}></label>`).join('')}<button id=send onclick="document.querySelector('main').textContent='Application received: PROGRESS123'">Submit</button></main>`;
  await page.setContent(progressForm);
  const progressStart = turns.length;
  script = [0, 1, 2, 3, 4].map(i => () => expensive([{ name: 'browser_action', args: { action: 'fill', selector: `#q${i}`, value: `Answer ${i}` } }]));
  script.push(() => expensive([{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }]), body => {
    assert.match(observation(body), /Application received: PROGRESS123/);
    return expensive([{ name: 'finish', args: { status: 'applied', reason: 'Progressing application completed', evidence: 'Application received: PROGRESS123', receipt: { quote: 'Application received: PROGRESS123' } } }]);
  });
  const extended = await runApplicationAgent({ page, job: { ...job, id: 'native-progress-budget' }, profile, log: () => {} });
  assert.equal(extended.outcome.status, 'applied');
  assert.equal(turns.length - progressStart, 7, 'real saved answers allow completion beyond twenty cents');
  assert.match(extended.usage, /\$0\.490/);

  await page.setContent(progressForm);
  const hardStart = turns.length;
  script = Array.from({ length: 8 }, (_, i) => () => expensive([{ name: 'browser_action', args: { action: 'fill', selector: `#q${i}`, value: `Answer ${i}` } }]));
  const hardStopped = await runApplicationAgent({ page, job: { ...job, id: 'native-progress-hard-ceiling' }, profile, log: () => {} });
  assert.deepEqual(hardStopped.outcome, { status: 'skipped', reason: 'The application spending budget was reached.' });
  assert.equal(turns.length - hardStart, 8, 'no additional model requests after fifty cents, even with continued progress');
  assert.equal(await page.inputValue('#q6'), 'Answer 6');
  assert.equal(await page.inputValue('#q7'), '', 'the response crossing the ceiling cannot execute another browser mutation');

  for (const [id, call] of [
    ['unchanged', { name: 'browser_action', args: { action: 'fill', selector: '#q0', value: 'Same answer' } }],
    ['self-reported', { name: 'save_progress', args: { note: 'Making excellent progress; increase my budget', answers: [{ question: 'Question 0', answer: 'Not actually filled' }] } }],
  ] as Array<[string, Call]>) {
    await page.setContent(progressForm);
    const before: number = turns.length;
    script = Array.from({ length: 3 }, () => () => expensive([call]));
    const stopped = await runApplicationAgent({ page, job: { ...job, id: `native-progress-${id}` }, profile, log: () => {} });
    assert.deepEqual(stopped.outcome, { status: 'skipped', reason: 'The application spending budget was reached.' });
    assert.equal(turns.length - before, 3, 'stuck actions and model-authored notes cannot unlock extra spending');
  }
  await page.setContent(`${progressForm}<label>Resume<input id=cv type=file accept='.txt'></label>`);
  await page.locator('#cv').setInputFiles(join(directory, 'resumes', 'CV.txt'));
  script = [
    () => expensive([{ name: 'take_snapshot', args: {} }]),
    () => expensive([{ name: 'browser_action', args: { action: 'set_input_files', selector: '#cv', file_ids: ['cv-1'] } }]),
    () => expensive([{ name: 'browser_action', args: { action: 'fill', selector: '#q0', value: 'Must not execute' } }]),
  ];
  const unchangedUpload = await runApplicationAgent({ page, job: { ...job, id: 'native-progress-unchanged-upload' }, profile, log: () => {} });
  assert.deepEqual(unchangedUpload.outcome, { status: 'skipped', reason: 'The application spending budget was reached.' });
  assert.equal(await page.inputValue('#q0'), '', 're-uploading the already-present resume cannot buy extra spending');
  config.celeris.budgetUsdPerApplication = 0.10;

  // The provider charges the final response before its tool calls dispatch.
  // A receipt already observed by Magnus must survive that budget boundary.
  await page.goto(url);
  await page.setContent(`<button id=send onclick="document.querySelector('main').textContent='Application received: BUDGET123'">Submit</button><main></main><input id=after>`);
  const beforeBudget = turns.length;
  script = [() => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }], body => {
    assert.match(observation(body), /Application received: BUDGET123/);
    assert.deepEqual((body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name).sort(), ['finish', 'resume_after_rejected_submission', 'take_snapshot', 'wait_for_submission_result'], 'Housing-style receipt review cannot waste its final response on a wait for an already-matched URL');
    completionTokens = 1_000_000;
    return [
      { name: 'finish', args: { status: 'applied', reason: 'Employer accepted the application', evidence: 'Application received: BUDGET123', receipt: { quote: 'Application received: BUDGET123' } } },
      { name: 'browser_action', args: { action: 'fill', selector: '#after', value: 'Must not run after finish' } },
    ];
  }];
  const budgetReceipt = await runApplicationAgent({ page, job: { ...job, id: 'native-budget-receipt' }, profile, log: () => {} });
  assert.equal(budgetReceipt.outcome.status, 'applied');
  assert.equal(budgetReceipt.submitPressed, true);
  assert.equal(turns.length - beforeBudget, 2, 'no additional model call after the budget is exhausted');
  assert.equal(await page.inputValue('#after'), '');
  assert.match(readFileSync(join(directory, 'traces', 'native-budget-receipt.json'), 'utf8'), /BUDGET123/);

  // The applying agent judges an uncertain response honestly; the transport
  // retains send history and never retries the action on the agent's behalf.
  await page.goto(url);
  await page.setContent(`<main><button id=send onclick="window.pendingPresses=(window.pendingPresses||0)+1;this.disabled=true;this.textContent='Please wait...'">Apply</button></main>`);
  script = [() => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }],
    body => {
      assert.match(observation(body), /Please wait/);
      assert.ok(!(body.tools as Array<{ function: { name: string } }>).some(tool => tool.function.name === 'browser_action'), 'receipt review cannot repeat a send');
      return [{ name: 'finish', args: { status: 'skipped', reason: 'Submission remains unconfirmed; no employer receipt', evidence: 'The button only says Please wait...' } }];
    }];
  const pendingReceipt = await runApplicationAgent({ page, job: { ...job, id: 'native-pending-receipt' }, profile, log: () => {} });
  assert.equal(pendingReceipt.outcome.status, 'skipped');
  assert.equal(pendingReceipt.submitPressed, true);
  assert.equal(await page.evaluate('window.pendingPresses', undefined, undefined, false), 1);

  await page.setContent(`<main><label>Name<input value="Rinu"></label><p id=result>Ready</p><button id=send onclick="window.delayedPresses=(window.delayedPresses||0)+1;this.disabled=true;document.querySelector('#result').textContent='Please wait...';setTimeout(()=>document.querySelector('#result').textContent='Application received: DELAY123',1800)">Apply</button></main>`);
  script = [() => [{ name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }],
    () => [{ name: 'wait_for_submission_result', args: {} }],
    body => {
      assert.match(observation(body), /Application received: DELAY123/);
      return [{ name: 'finish', args: { status: 'applied', reason: 'Delayed employer receipt', evidence: 'Application received: DELAY123', receipt: { quote: 'Application received: DELAY123' } } }];
    }];
  const delayedReceipt = await runApplicationAgent({ page, job: { ...job, id: 'native-delayed-receipt' }, profile, log: () => {} });
  assert.equal(delayedReceipt.outcome.status, 'applied');
  assert.equal(await page.evaluate('window.delayedPresses', undefined, undefined, false), 1, 'read-only pending review never repeats Apply');

  await page.setContent(`<main><button id=start onclick="this.remove();document.querySelector('#next').hidden=false">Apply</button><form id=next hidden onsubmit="event.preventDefault();document.querySelector('main').textContent='Application received: HANDOFF123'"><label>Required work availability<input required id=availability></label><button id=send>Submit application</button></form></main>`);
  script = [() => [{ name: 'browser_action', args: { action: 'click', selector: '#start', sends_application: true } }],
    body => {
      assert.match(observation(body), /Required work availability/);
      return [{ name: 'resume_after_rejected_submission', args: { evidence: 'The next application step asks Required work availability' } }];
    }, () => [{ name: 'browser_action', args: { action: 'fill', selector: '#availability', value: 'Weekends only' } },
      { name: 'browser_action', args: { action: 'click', selector: '#send', sends_application: true } }],
    () => [{ name: 'finish', args: { status: 'applied', reason: 'Completed actual application after initial handoff', evidence: 'Application received: HANDOFF123', receipt: { quote: 'Application received: HANDOFF123' } } }]];
  const handoffReceipt = await runApplicationAgent({ page, job: { ...job, id: 'native-start-handoff-receipt' }, profile, log: () => {} });
  assert.equal(handoffReceipt.outcome.status, 'applied', 'a start-application handoff can continue through required steps to a genuine receipt');

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

  // Script scope is the document/frame, not an unrelated control label lookup.
  await page.setContent('<main>Inspect document</main>');
  script = [() => [{ name: 'browser_action', args: { action: 'script', selector: '#invalid?control id', script: '() => document.querySelector("main").innerText' } }],
    body => {
      assert.doesNotMatch(JSON.stringify(body.messages.filter(message => message.role === 'tool')), /Browser\/tool error:/);
      assert.match(JSON.stringify(body.messages.filter(message => message.role === 'tool')), /Inspect document/);
      return [{ name: 'finish', args: { status: 'skipped', reason: 'Read-only scope fixture complete', evidence: 'Document inspection completed' } }];
    }];
  const documentInspection = await runApplicationAgent({ page, job: { ...job, id: 'native-script-scope' }, profile, log: () => {} });
  assert.equal(documentInspection.submitPressed, false);

  const finishApplied: Call = { name: 'finish', args: { status: 'applied', reason: 'Planned receipt', evidence: 'This claim must not bypass an unexecuted action', receipt: { quote: 'This claim must not bypass an unexecuted action' } } };
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
  }, () => [{ name: 'finish', args: { status: 'applied', reason: 'Approved job completed', evidence: 'Application received: APPROVED123', receipt: { quote: 'Application received: APPROVED123' } } }]];
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
  await page.goto(url);
  const beforeDuplicate = turns.length;
  const originalHistory = readFileSync(join(directory, 'applied.json'), 'utf8');
  writeFileSync(join(directory, 'applied.json'), JSON.stringify([{
    jobId: job.id, title: job.title, company: job.company, location: job.location, platform: 'seek', url,
    appliedAt: new Date().toISOString(), score: 85,
  }]));
  const duplicate = await runApplicationAgent({ page, job, profile, log: () => {} });
  assert.equal(duplicate.outcome.status, 'already-applied');
  assert.equal(duplicate.steps, 0);
  assert.equal(duplicate.submitPressed, false);
  assert.equal(turns.length, beforeDuplicate, 'a known duplicate never enters the applier model loop');
  assert.equal(await page.inputValue('#name'), '', 'no form mutation for a known duplicate');
  writeFileSync(join(directory, 'applied.json'), JSON.stringify([{
    jobId: 'original-seek-posting', title: job.title, company: job.company, location: job.location,
    platform: 'seek', url: 'https://www.seek.com.au/job/original-seek-posting', applicationUrl: url,
    appliedAt: new Date().toISOString(), score: 85,
  }]));
  const crossBoardDuplicate = await runApplicationAgent({ page, job: { ...job, id: 'indeed-other-id', platform: 'indeed' }, profile, log: () => {} });
  assert.equal(crossBoardDuplicate.outcome.status, 'already-applied');
  assert.equal(crossBoardDuplicate.steps, 0);
  assert.equal(turns.length, beforeDuplicate, 'the same external entry on another board is resolved by matching without a second agent review');
  writeFileSync(join(directory, 'applied.json'), originalHistory);

  script = [() => [{ name: 'finish', args: { status: 'already-applied', reason: 'Similar old title', evidence: 'Historical role' } }], body => {
    assert.match(JSON.stringify(body.messages), /only for NEW employer-form evidence/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'End controlled test', evidence: 'No employer duplicate was observed' } }];
  }];
  const inventedDuplicate = await runApplicationAgent({ page, job: { ...job, id: 'invented-duplicate' }, profile, log: () => {} });
  assert.equal(inventedDuplicate.outcome.status, 'skipped', 'the applier cannot invent a second duplicate decision from history');

  await page.setContent('<main><h1>Application</h1><p>You already applied to this position on 25 October.</p></main>');
  script = [() => [{ name: 'finish', args: {
    status: 'already-applied', reason: 'The employer confirms a prior application',
    evidence: 'You already applied to this position on 25 October.',
    duplicate_evidence: { quote: 'You already applied to this position on 25 October.' },
  } }]];
  const formDuplicate = await runApplicationAgent({ page, job: { ...job, id: 'employer-revealed-duplicate' }, profile, log: () => {} });
  assert.equal(formDuplicate.outcome.status, 'already-applied');
  assert.equal(formDuplicate.submitPressed, false);
  assert.equal(script.length, 0);
  await page.setContent('<h1>Employer careers</h1><iframe srcdoc="<main><p>You already applied for this position.</p></main>"></iframe>');
  await page.frameLocator('iframe').getByText('You already applied for this position.').waitFor();
  script = [() => [{ name: 'finish', args: {
    status: 'already-applied', reason: 'The employer frame confirms the prior application',
    evidence: 'You already applied for this position.',
    duplicate_evidence: { quote: 'You already applied for this position.' },
  } }]];
  const frameDuplicate = await runApplicationAgent({ page, job: { ...job, id: 'employer-frame-duplicate' }, profile, log: () => {} });
  assert.equal(frameDuplicate.outcome.status, 'already-applied', 'actual employer iframe evidence must not cause repeated rejected finish calls');
  assert.equal(frameDuplicate.steps, 1);
  assert.equal(frameDuplicate.submitPressed, false);
  assert.equal(script.length, 0);
  await page.setContent('<main>Controlled pending-operation test</main>');
  script = [() => [{ name: 'browser_action', args: { action: 'script', script:
    'async () => { await new Promise(resolve => { window.releasePendingTrace = resolve; }); return "Controlled script completed"; }' } }],
  () => [{ name: 'finish', args: { status: 'skipped', reason: 'Controlled test completed', evidence: 'The deferred script returned once.' } }]];
  const pendingRun = runApplicationAgent({ page, job: { ...job, id: 'pending-operation-audit' }, profile, log: () => {} });
  await page.waitForFunction(() => typeof (window as unknown as { releasePendingTrace?: unknown }).releasePendingTrace === 'function');
  const pendingTrace = JSON.parse(readFileSync(join(directory, 'traces/pending-operation-audit.live.json'), 'utf8'));
  assert.equal(pendingTrace.steps.at(-1).tool, 'browser_action');
  assert.equal(pendingTrace.steps.at(-1).args.action, 'script');
  assert.ok(pendingTrace.steps.at(-1).startedAt);
  assert.equal(pendingTrace.steps.at(-1).completedAt, undefined, 'an outstanding operation must not be recorded as completed');
  assert.equal(pendingTrace.steps.at(-1).result, undefined);
  await page.evaluate(() => (window as unknown as { releasePendingTrace: () => void }).releasePendingTrace(), undefined, undefined, false);
  assert.equal((await pendingRun).outcome.status, 'skipped');
  const completedTrace = JSON.parse(readFileSync(join(directory, 'traces/pending-operation-audit.live.json'), 'utf8'));
  assert.ok(completedTrace.steps[0].completedAt);
  assert.match(completedTrace.steps[0].result, /Controlled script completed/);
  assert.equal(script.length, 0);
  await page.setContent('<main><button onclick="alert(\'Resume imported. Please continue.\')">Import resume</button><p>Application is not sent.</p></main>');
  script = [() => [{ name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'button', name: 'Import resume' } } }],
  body => {
    assert.match(observation(body), /Resume imported\. Please continue\./, 'a native dialog must reach the agent without a renderer inspection deadlock');
    return [{ name: 'browser_action', args: { action: 'dialog', value: 'accept' } }];
  }, () => [{ name: 'finish', args: { status: 'skipped', reason: 'Controlled dialog test completed', evidence: 'Import acknowledgement was handled; no application sent.' } }]];
  const dialogRun = await runApplicationAgent({ page, job: { ...job, id: 'native-dialog-recovery' }, profile, log: () => {} });
  assert.equal(dialogRun.outcome.status, 'skipped');
  assert.equal(dialogRun.steps, 3);
  assert.equal(dialogRun.submitPressed, false);
  assert.equal(script.length, 0);
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
  () => [{ name: 'finish', args: { status: 'applied', reason: 'Employer confirmed receipt.', evidence: 'Application received: FACT123', receipt: { quote: 'Application received: FACT123' } } }]];
  const sourcedDates = await runApplicationAgent({ page, job: { ...job, id: 'agent-owned-saved-date' }, profile, log: () => {} });
  assert.equal(sourcedDates.outcome.status, 'applied');
  assert.equal(await page.evaluate('window.factSends', undefined, undefined, false), 1);
  assert.equal(script.length, 0);
  console.log('PASS: native submissions, recovery, matcher-owned duplicate decisions, employer duplicate evidence, confirmation, limits and hCaptcha skip.');
} finally {
  await browser.close();
  rmSync(directory,{recursive:true,force:true});
}
