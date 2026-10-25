import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { JobListing } from '../types.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-agent-only-'));
process.env.BRIGHTDATA_BROWSER_ENABLED = 'false';
process.env.EMPLOYER_BROWSER_PROVIDER = 'local';
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', FORM_CORPUS_DIR: join(directory, 'form-corpus'),
  ALLOW_EXTERNAL_APPLY: 'true', DRY_RUN: 'false' });
process.env.APPLICATION_AI_MODEL = 'celeris';
const { applicationFailureContext } = await import('../application-diagnostics.js');
writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: 'Availability', answer: 'Weekends only' }]));
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Private candidate CV evidence: pharmacy placement.');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv-1', label: 'Pharmacy CV', fileName: 'CV.txt', isDefault: true }]));
writeFileSync(join(directory, 'applied.json'), JSON.stringify([{ id: 'old-job', title: 'Prior role', platform: 'seek', appliedAt: new Date().toISOString() }]));

type Call = { name: string; args: Record<string, unknown> };
type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; output_config?: { effort?: string }; chat_template_kwargs?: { reasoning_effort?: string } };
let script: Array<(body: Body) => Call[]> = [];
const turns: Body[] = [];
const observation = (body: Body) => JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content);
const reply = (calls: Call[]) => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({ id: `turn-${turns.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }], usage: { prompt_tokens: 30, completion_tokens: 10 } });
globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as Body;
  assert.ok(body.tools?.length, 'no independent checker, answerer, receipt verifier or script reviewer may be called');
  turns.push(body);
  const next = script.shift();
  assert.ok(next, 'the parent makes only the scripted number of requests');
  return reply(next(body));
}) as typeof fetch;
const { runApplicationAgent } = await import('./loop.js');
const { withApplicationModel } = await import('../application-model.js');
const { config } = await import('../config.js');
const { withApplicationAllowance } = await import('../application-allowance.js');
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
    return [{ name: 'reason_through_problem', args: { problem: 'The first submission was rejected. Correct the actual referral source and retry.' } }];
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
  script = [body => {
    assert.match(JSON.stringify(body.tools), /fill_fields/);
    return [
      { name: 'fill_fields', args: { fields: [{ ref: 'f0', value: 'Rinu Fixture' }, { ref: 'f1', value: 'fixture@example.invalid' }, { ref: 'f2', value: letter }, { ref: 'f3', value: 'Company website' }] } },
      { name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } },
    ];
  }, body => {
    assert.match(JSON.stringify(body.messages), /Wrote 4 fields in one batch/);
    assert.equal(effort(body), 'medium', 'successful batching does not trigger expensive failure reasoning');
    assert.match(observation(body), /Rinu Fixture/);
    return [{ name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } }];
  }, body => {
    assert.match(observation(body), /Receipt ABC123/);
    return [{ name: 'finish', args: { status: 'applied', reason: 'Batched fields saved then receipt inspected', evidence: 'Receipt ABC123' } }];
  }];
  const batched = await runApplicationAgent({ page, job: { ...job, id: 'agent-field-batch' }, profile, log: () => {} });
  assert.equal(batched.outcome.status, 'applied');
  assert.equal(turns.length - beforeBatch, 3, 'four answers are authored and written in a single model turn, then observed before sending');
  assert.equal(await page.evaluate('window.presses', undefined, undefined, false), 1, 'a submission in the batch turn waits for the next observation');
  assert.equal(batched.coverLetter, letter);
  assert.equal(batched.captured.length, 4);

  await page.goto(url);
  script = [body => {
    const instructions = String(body.messages.find(message => message.role === 'system')?.content);
    assert.match(instructions, /USER-SELECTED APPLICATION/);
    assert.match(instructions, /current selection overrides ordinary search keywords/);
    assert.match(instructions, /never claim experience, qualifications or legal permissions the candidate does not have/);
    assert.match(instructions, /does not authorize duplicate or uncertain sends, bypass candidate confirmation, or change saved preferences/);
    return [{ name: 'browser_action', args: { action: 'fill', selector: '#name', value: 'Rinu Fixture' } }];
  }, () => [{ name: 'finish', args: { status: 'skipped', reason: 'Offline explicit selection received', evidence: 'Selection reached the application agent with truthful-answer and submission protections' } }]];
  await runApplicationAgent({ page, job: { ...job, id: 'agent-explicit-job-selection', title: 'Different career title', source: 'chosen' }, profile, log: () => {} });
  assert.equal(await page.inputValue('#name'), 'Rinu Fixture');

  await page.goto(url);
  await page.setContent(`<main><label>City<input id=city role=combobox aria-controls=cities aria-autocomplete=list oninput="document.querySelector('#cities').hidden=false"></label>
    <div id=cities role=listbox hidden><button type=button role=option onclick="document.querySelector('#city').value='Sydney NSW';this.parentElement.hidden=true">Sydney NSW</button></div></main>`);
  script = [body => {
    assert.match(observation(body), /autocomplete: type then choose an observed suggestion/);
    return [{ name: 'fill_fields', args: { fields: [{ ref: 'f0', value: 'Sydney' }] } }];
  }, body => {
    assert.match(JSON.stringify(body.messages), /Blocked fields.*City.*autocomplete/);
    return [{ name: 'fill_fields', args: { fields: [{ ref: 'f0', value: 'Sydney' }] } }];
  }, body => {
    assert.equal(effort(body), 'xhigh');
    assert.match(observation(body), /No visible progress after 2 consecutive action turns/);
    return [{ name: 'browser_action', args: { action: 'fill', ref: 'f0', value: 'Sydney' } },
      { name: 'browser_action', args: { action: 'click', selector: '#missing-dependent-action' } }];
  }, body => {
    assert.match(JSON.stringify(body.messages), /Autocomplete text is not a committed selection/);
    assert.match(JSON.stringify(body.messages), /Not run: inspect the fresh observation/);
    return [{ name: 'browser_action', args: { action: 'click', selector: '[role=option]' } }];
  }, body => {
    assert.match(observation(body), /Sydney NSW/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Offline widget recovered', evidence: 'Selected Sydney NSW from the actual dropdown' } }];
  }];
  const widget = await runApplicationAgent({ page, job: { ...job, id: 'agent-widget-recovery' }, profile, log: () => {} });
  assert.equal(Boolean(widget.submitPressed), false);
  assert.equal(await page.inputValue('#city'), 'Sydney NSW');
  assert.equal(script.length, 0);

  // The agent chooses the custom-widget sequence; transport only performs
  // standard locator actions. Country and phone remain separate controls.
  await page.goto(url);
  await page.setContent(`<main><h1>Contact details</h1>
    <button type=button aria-label="Country information" onclick="window.wrongCountry=true">Country information</button>
    <button type=button aria-label="Country" aria-controls=countries onclick="document.querySelector('#countries').hidden=false">Choose country</button>
    <div role=listbox aria-label=Countries id=countries hidden>
      <button type=button role=option onclick="document.querySelector('[aria-label=Country]').textContent='Australia +61';document.querySelector('#countries').hidden=true;window.country='AU'">Australia +61</button>
    </div>
    <label>Phone<input type=tel id=phone></label>
    <label>City<input id=city placeholder="Search city" role=combobox aria-controls=cities aria-autocomplete=list oninput="document.querySelector('#cities').hidden=false"></label>
    <div role=listbox aria-label=Cities id=cities hidden><button type=button role=option onclick="document.querySelector('#city').value='Sydney NSW';this.parentElement.hidden=true">Sydney NSW</button></div>
    <button type=button id=advance onclick="window.advanced=true">Next</button></main>`);
  const customStarted = performance.now();
  script = [body => {
    const instructions = String(body.messages.find(message => message.role === 'system')?.content);
    assert.match(instructions, /no automatic custom-widget filler/);
    assert.match(instructions, /After two attempts/);
    return [{ name: 'browser_action', args: { action: 'select', locator: { by: 'role', value: 'button', name: 'Country' }, value: 'Australia +61' } },
      { name: 'browser_action', args: { action: 'click', selector: '#advance' } }];
  }, body => {
    assert.match(JSON.stringify(body.messages), /not a native HTML select/);
    assert.match(JSON.stringify(body.messages), /Not run: inspect the fresh observation/);
    return [{ name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'button', name: 'Country' } } }];
  }, body => {
    assert.match(observation(body), /Australia \+61/);
    return [{ name: 'take_snapshot', args: { locator: { by: 'role', value: 'listbox', name: 'Countries' } } }];
  }, body => {
    assert.match(JSON.stringify(body.messages), /option.*Australia \+61/);
    return [
      { name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'option', name: 'Australia +61' } } },
      { name: 'browser_action', args: { action: 'fill', locator: { by: 'label', value: 'Phone' }, value: '412345678' } },
      { name: 'browser_action', args: { action: 'fill', locator: { by: 'placeholder', value: 'Search city' }, value: 'Sydney' } },
      { name: 'browser_action', args: { action: 'click', selector: '#advance' } },
    ];
  }, body => {
    assert.match(JSON.stringify(body.messages), /Autocomplete text is not a committed selection/);
    return [{ name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'option', name: 'Sydney NSW' } } }];
  }, () => [{ name: 'finish', args: { status: 'skipped', reason: 'Offline direct-control benchmark', evidence: 'Country AU, phone and selected Sydney NSW inspected' } }]];
  const custom = await runApplicationAgent({ page, job: { ...job, id: 'agent-direct-custom-controls' }, profile, log: () => {} });
  assert.equal(await page.evaluate('window.country', undefined, undefined, false), 'AU');
  assert.equal(await page.inputValue('#phone'), '412345678');
  assert.equal(await page.inputValue('#city'), 'Sydney NSW');
  assert.equal(await page.evaluate('Boolean(window.wrongCountry || window.advanced)', undefined, undefined, false), false);
  assert.equal(custom.captured.find(answer => answer.question === 'Phone')?.answer, '412345678');
  assert.equal(script.length, 0);
  console.log(JSON.stringify({ directCustomControlsMs: Math.round(performance.now() - customStarted), model: 'scripted offline fixture' }));

  await page.goto(url);
  await page.setContent(`<main><section id=first><button type=button onclick="window.firstClicked=true">Continue</button></section>
    <section id=second><button type=button onclick="window.secondClicked=true">Continue</button></section>
    <div id=shadow></div><iframe id=employer srcdoc="<label>Email<input placeholder='Employer email'></label>"></iframe></main>`);
  await page.locator('#shadow').evaluate(node => { node.attachShadow({ mode: 'open' }).innerHTML = '<label>Shadow name<input data-testid="shadow-name"></label>'; });
  script = [() => [
    { name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'button', name: 'Continue' } } },
    { name: 'browser_action', args: { action: 'click', selector: '#first button' } },
  ], body => {
    assert.match(JSON.stringify(body.messages), /strict mode violation/);
    return [
      { name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'button', name: 'Continue', within: '#second' } } },
      { name: 'browser_action', args: { action: 'fill', locator: { by: 'test_id', value: 'shadow-name' }, value: 'Shadow candidate' } },
      { name: 'browser_action', args: { action: 'fill', ref: 'f999999', selector: '#missing', locator: { by: 'placeholder', value: 'Employer email', frame: '#employer' }, value: 'fixture@example.invalid' } },
    ];
  }, () => [{ name: 'take_snapshot', args: { locator: { by: 'css', value: 'body', frame: '#employer' } } }], body => {
    assert.match(JSON.stringify(body.messages), /Employer email/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Offline scoped controls exercised', evidence: 'Unique section, shadow and iframe fields saved' } }];
  }];
  const scoped = await runApplicationAgent({ page, job: { ...job, id: 'agent-direct-locator-scopes' }, profile, log: () => {} });
  assert.equal(await page.evaluate('Boolean(window.firstClicked)', undefined, undefined, false), false, 'ambiguous targeting and its queued action do not execute');
  assert.equal(await page.evaluate('window.secondClicked', undefined, undefined, false), true);
  assert.equal(await page.getByTestId('shadow-name').inputValue(), 'Shadow candidate');
  assert.equal(await page.frameLocator('#employer').getByPlaceholder('Employer email').inputValue(), 'fixture@example.invalid');
  assert.ok(scoped.captured.some(answer => answer.question === 'Email' && answer.answer === 'fixture@example.invalid'));
  assert.equal(script.length, 0);

  await page.goto(url);
  await page.setContent(`<main><label>Phone<input type=tel id=phone onblur="this.value=this.value.replace(/ /g,'')"></label>
    <label>From date<input id=date placeholder=MM/YYYY onblur="this.value='';this.setAttribute('aria-invalid','true')"></label><button type=button id=advance onclick="window.advanced=true">Next</button></main>`);
  script = [() => [{ name: 'browser_action', args: { action: 'fill', selector: '#phone', value: '+61 412 345 678' } },
    { name: 'browser_action', args: { action: 'fill', selector: '#date', value: '2024-01-01' } },
    { name: 'browser_action', args: { action: 'click', selector: '#advance' } }], body => {
    assert.equal(effort(body), 'xhigh');
    assert.match(JSON.stringify(body.messages), /browser readback/);
    assert.match(observation(body), /validation=.*field invalid/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Offline validation exposed', evidence: 'Date was rejected; queued Next was not executed' } }];
  }];
  const readback = await runApplicationAgent({ page, job: { ...job, id: 'agent-field-readback' }, profile, log: () => {} });
  assert.equal(readback.captured.find(answer => answer.question === 'Phone')?.answer, '+61412345678');
  assert.equal(readback.captured.find(answer => answer.question === 'From date')?.answer, '');
  assert.equal(await page.evaluate('Boolean(window.advanced)', undefined, undefined, false), false);

  await page.goto(url);
  await page.setContent(`<main aria-busy=true><p>Loading application</p><button>Cancel</button></main><script>setTimeout(()=>{const main=document.querySelector('main');main.removeAttribute('aria-busy');main.innerHTML='<label>Name<input></label><button>Next</button>'},300)</script>`);
  script = [body => {
    assert.match(observation(body), /FIELDS \(1\)/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Offline application ready', evidence: 'First model call sees the loaded form' } }];
  }];
  await runApplicationAgent({ page, job: { ...job, id: 'agent-loading-surface' }, profile, log: () => {} });
  assert.equal(script.length, 0);

  config.dryRun = true;
  await page.goto(url);
  script = [() => [{ name: 'fill_fields', args: { fields: [{ ref: 'f0', value: 'Must stay empty' }] } }]];
  assert.equal((await runApplicationAgent({ page, job: { ...job, id: 'agent-batch-dry' }, profile, log: () => {} })).outcome.status, 'rehearsed');
  assert.equal(await page.inputValue('#name'), '', 'production dry-run prevents batched mutations too');
  config.dryRun = false;
  script = [() => [{ name: 'fill_fields', args: { fields: [{ ref: 'f0', value: 'Must stay empty' }] } }]];
  assert.equal((await withApplicationAllowance(async () => false, () => runApplicationAgent({ page, job: { ...job, id: 'agent-batch-quota' }, profile, log: () => {} }))).outcome.status, 'skipped');
  assert.equal(await page.inputValue('#name'), '', 'account quota applies to the new batch tool');

  await page.goto(url);
  await page.locator('#name').evaluate(el => el.addEventListener('blur', () => { document.querySelector('#email')!.setAttribute('disabled', ''); }));
  script = [() => [
    { name: 'fill_fields', args: { fields: [{ ref: 'f0', value: 'Rinu Fixture' }, { ref: 'f1', value: 'fixture@example.invalid' }] } },
    { name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } },
  ], body => {
    assert.equal(effort(body), 'medium', 'a dynamic form handoff is not a reasoning failure');
    assert.match(JSON.stringify(body.messages), /Remaining fields were not written/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Dynamic form handoff observed', evidence: 'Name saved, email disabled' } }];
  }];
  const handoff = await runApplicationAgent({ page, job: { ...job, id: 'agent-batch-handoff' }, profile, log: () => {} });
  assert.equal(handoff.outcome.status, 'skipped');
  assert.equal(Boolean(handoff.submitPressed), false);
  assert.equal(await page.inputValue('#email'), '');
  assert.equal(await page.evaluate('window.presses ?? 0', undefined, undefined, false), 0, 'a partial batch cannot run a queued submit');

  await page.goto(url);
  script = [() => [{ name: 'browser_action', args: { action: 'script', script: '() => { document.querySelector("#name").value = "Scripted"; return document.querySelector("#name").value; }' } }],
    body => { assert.match(observation(body), /Scripted/); return [{ name: 'finish', args: { status: 'skipped', reason: 'Script exercised', evidence: 'Saved name Scripted' } }]; }];
  assert.equal((await runApplicationAgent({ page, job: { ...job, id: 'agent-script' } as never, profile, log: () => {} })).outcome.status, 'skipped');
  assert.equal(await page.inputValue('#name'), 'Scripted');

  await page.goto(url);
  script = [() => [{ name: 'take_snapshot', args: { selector: 'form' } }], body => {
    const texts = body.messages.flatMap(message => typeof message.content === 'string' ? [message.content]
      : Array.isArray(message.content) ? message.content.map(part => String((part as { text?: string; content?: string }).text ?? (part as { content?: string }).content ?? '')) : []);
    assert.equal(texts.filter(text => /button "Submit" \[ref=/.test(text)).length, 1, 'a snapshot appears once as a tool result');
    return [{ name: 'browser_action', args: { action: 'script', script: 'await new Promise(resolve => setTimeout(resolve, 1)); document.querySelector("#name").value = "Async body"; return document.querySelector("#name").value;' } }];
  }, body => {
    assert.match(observation(body), /Async body/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Async body and scoped snapshot exercised', evidence: 'Saved name Async body' } }];
  }];
  await runApplicationAgent({ page, job: { ...job, id: 'agent-snapshot-once' }, profile, log: () => {} });
  assert.equal(await page.inputValue('#name'), 'Async body');

  await page.goto(url);
  script = [() => [
    { name: 'browser_action', args: { action: 'fill', selector: '#name' } },
    { name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } },
  ], body => {
    assert.match(JSON.stringify(body.messages), /Not run: the prior action failed/);
    assert.equal(effort(body), 'xhigh');
    return [{ name: 'finish', args: { status: 'needs-human', reason: 'A consequential candidate fact is unknown', evidence: 'No candidate evidence supplied for this fact' } }];
  }];
  const failedInput = await runApplicationAgent({ page, job: { ...job, id: 'agent-invalid-input' }, profile, log: () => {} });
  assert.equal(failedInput.outcome.status, 'needs-human');
  assert.equal(await page.evaluate('window.presses ?? 0', undefined, undefined, false), 0, 'a failed action retires the rest of that model plan');

  await page.goto(url);
  script = [() => [{ name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } }]];
  const denied = await withApplicationAllowance(async () => false, () => runApplicationAgent({ page, job: { ...job, id: 'agent-no-quota' }, profile, log: () => {} }));
  assert.equal(denied.outcome.status, 'skipped');
  assert.equal(await page.evaluate('window.presses ?? 0', undefined, undefined, false), 0, 'account quota still prevents transmission');

  config.dryRun = true;
  await page.goto(url);
  script = [() => [{ name: 'browser_action', args: { action: 'script', script: '() => { document.querySelector("#submit").click(); }', sends_application: true } }]];
  const dryRun = await runApplicationAgent({ page, job: { ...job, id: 'agent-dry' } as never, profile, log: () => {} });
  assert.equal(dryRun.outcome.status, 'rehearsed'); assert.equal(await page.evaluate('window.presses ?? 0', undefined, undefined, false), 0);
  script = [() => [{ name: 'finish', args: { status: 'applied', reason: 'Pretend', evidence: 'No actual receipt' } }]];
  assert.equal((await runApplicationAgent({ page, job: { ...job, id: 'agent-dry-finish' } as never, profile, log: () => {} })).outcome.status, 'rehearsed');
  config.dryRun = false;
  for (const legacyMode of [undefined, 'protected', 'agent-only']) {
    script = [body => {
      const names = (body.tools ?? []).map(tool => (tool as { function: { name: string } }).function.name);
      assert.ok(names.includes('browser_action') && !names.includes('answer_questions'));
      return [{ name: 'finish', args: { status: 'skipped', reason: 'Default engine checked', evidence: 'Fixture page' } }];
    }];
    const normal = await withApplicationModel({ ...process.env, APPLICATION_AGENT_MODE: legacyMode,
      APPLICATION_AGENT_MODE_AUTHORIZED: undefined }, () => runApplicationAgent({ page, job, profile, log: () => {} }));
    assert.equal(normal.outcome.status, 'skipped', 'ordinary accounts and stale settings use the same sole engine');
  }
  // A removed observed button must retire this plan immediately, then permit
  // the agent to choose the replacement from the refreshed page.
  await page.goto(url);
  script = [body => {
    const ref = /(a\d+)\s+\[button\]\s+Submit\b/.exec(observation(body))?.[1];
    assert.ok(ref, 'the first plan uses the actually observed Submit ref');
    return [
      { name: 'browser_action', args: { action: 'script', script: `document.querySelector('#submit').remove();const replacement=document.createElement('button');replacement.id='replacement';replacement.textContent='New continue';replacement.onclick=()=>replacement.textContent='Recovered';document.querySelector('main').append(replacement);` } },
      { name: 'browser_action', args: { action: 'click', ref, sends_application: true } },
      { name: 'browser_action', args: { action: 'fill', selector: '#name', value: 'Must not run' } },
    ];
  }, body => {
    assert.match(JSON.stringify(body.messages), /is no longer on the page/);
    assert.match(JSON.stringify(body.messages), /Not run: inspect the fresh observation/);
    assert.match(observation(body), /New continue/);
    assert.equal(effort(body), 'medium', 'a stale ref is a page change, not a reasoning failure');
    const ref = /(a\d+)\s+\[button\]\s+New continue\b/.exec(observation(body))?.[1];
    assert.ok(ref);
    return [{ name: 'browser_action', args: { action: 'click', ref } }];
  }, body => {
    assert.match(observation(body), /Recovered/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Recovered from a removed button', evidence: 'Replacement button shows Recovered' } }];
  }];
  const staleStart = performance.now();
  const recovered = await runApplicationAgent({ page, job: { ...job, id: 'agent-stale-recovery' }, profile, log: () => {} });
  const staleRecoveryMs = Math.round(performance.now() - staleStart);
  assert.ok(staleRecoveryMs < 3000, `stale recovery took ${staleRecoveryMs}ms; it must not wait out the 8s action timeout`);
  assert.equal(Boolean(recovered.submitPressed), false, 'a missing target is rejected before recording a possible send');
  assert.equal(await page.inputValue('#name'), '', 'later writes in a stale plan never execute');

  // All ref-targeted actions share the same fast handoff, including refs from
  // accessibility snapshots and frames which have since disappeared.
  for (const [index, call] of ([
    { name: 'browser_action', args: { action: 'fill', ref: 'f999999', value: 'No' } },
    { name: 'browser_action', args: { action: 'select', ref: 'f999999', value: 'No' } },
    { name: 'browser_action', args: { action: 'check', ref: 'f999999', value: 'true' } },
    { name: 'browser_action', args: { action: 'press', ref: 'f999999', value: 'Enter' } },
    { name: 'browser_action', args: { action: 'hover', ref: 'a999999' } },
    { name: 'browser_action', args: { action: 'check', ref: 'f999999:0', value: 'true' } },
    { name: 'browser_action', args: { action: 'click', ref: 'e999999' } },
    { name: 'browser_action', args: { action: 'click', ref: 'f999999e1' } },
    { name: 'browser_action', args: { action: 'click', ref: 'r1f999999e1' } },
    { name: 'take_snapshot', args: { ref: 'a999999' } },
    { name: 'upload_document', args: { ref: 'f999999', document_id: 'cv-1' } },
  ] satisfies Call[]).entries()) {
    await page.goto(url);
    script = [() => [call], body => {
      assert.match(JSON.stringify(body.messages), /is no longer on the page/);
      assert.equal(effort(body), 'medium');
      return [{ name: 'finish', args: { status: 'skipped', reason: 'Stale ref observed', evidence: 'Fresh application form' } }];
    }];
    const started = performance.now();
    const result = await runApplicationAgent({ page, job: { ...job, id: `agent-stale-tool-${index}` }, profile, log: () => {} });
    assert.ok(performance.now() - started < 2500, `${call.name}/${call.args.action ?? ''} must not wait for a disappeared target`);
    assert.equal(result.captured.length, 0);
    assert.equal(result.resumeUsed, undefined, 'an absent uploader does not record a chosen document');
  }

  // Existing-but-disabled refs and not-yet-rendered CSS targets still use
  // browser auto-waiting. Explicit selector targets keep priority over refs.
  await page.goto(url);
  script = [body => {
    const ref = /(a\d+)\s+\[button\]\s+Submit\b/.exec(observation(body))?.[1];
    assert.ok(ref);
    return [
      { name: 'browser_action', args: { action: 'script', script: `const b=document.querySelector('#submit');b.disabled=true;b.type='button';b.onclick=()=>b.textContent='Ready clicked';setTimeout(()=>b.disabled=false,250);` } },
      { name: 'browser_action', args: { action: 'click', ref } },
      { name: 'browser_action', args: { action: 'script', script: `setTimeout(()=>document.querySelector('main').insertAdjacentHTML('beforeend','<label>Later input<input id="later"></label>'),250);` } },
      { name: 'browser_action', args: { action: 'fill', ref: 'f999999', selector: '#later', value: 'Waited correctly' } },
    ];
  }, body => {
    assert.match(observation(body), /Ready clicked/);
    assert.match(observation(body), /Waited correctly/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Legitimate waits preserved', evidence: 'Button and late input accepted their actions' } }];
  }];
  await runApplicationAgent({ page, job: { ...job, id: 'agent-stale-legitimate-waits' }, profile, log: () => {} });

  await page.goto(url);
  await page.locator('main').evaluate(el => { el.innerHTML = '<div id="shadow-host"></div>'; el.querySelector('#shadow-host')!.attachShadow({ mode: 'open' }).innerHTML = '<label>Shadow field<input id="shadow-input"></label><fieldset><legend>Available</legend><label><input type="radio" name="available">Yes</label><label><input type="radio" name="available">No</label></fieldset>'; });
  script = [body => {
    const field = /(f\d+)\s+\[text\]/.exec(observation(body))?.[1];
    const radio = /(f\d+)\s+\[radio\]/.exec(observation(body))?.[1];
    assert.ok(field && radio);
    return [
      { name: 'browser_action', args: { action: 'fill', ref: field, value: 'Shadow value' } },
      { name: 'browser_action', args: { action: 'check', ref: `${radio}:0`, value: 'true' } },
    ];
  }, body => {
    assert.match(observation(body), /Shadow value/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Shadow and radio refs retained', evidence: 'Saved field value and radio choice' } }];
  }];
  await runApplicationAgent({ page, job: { ...job, id: 'agent-stale-shadow-radio' }, profile, log: () => {} });
  assert.equal(await page.locator('#shadow-input').inputValue(), 'Shadow value');
  assert.equal(await page.locator('input[type=radio]').first().isChecked(), true);

  // Snapshot refs resolve in their own frame; a page-wide CSS-only existence
  // check would wrongly treat a live iframe ref as stale.
  await page.goto(url);
  await page.locator('main').evaluate(el => { const frame = document.createElement('iframe'); frame.srcdoc = '<button>Frame action</button>'; el.replaceChildren(frame); });
  await page.frameLocator('iframe').locator('button').waitFor();
  await page.frames()[1].locator('button').evaluate(el => el.addEventListener('click', () => { el.textContent = 'Frame clicked'; }));
  script = [() => [{ name: 'take_snapshot', args: {} }], body => {
    const all = JSON.stringify(body.messages);
    const ref = /button \\"Frame action\\" \[ref=(f\d+e\d+)\]/.exec(all)?.[1];
    assert.ok(ref, 'a real iframe snapshot ref was returned');
    return [{ name: 'browser_action', args: { action: 'click', ref } }];
  }, body => {
    assert.match(JSON.stringify(body.messages), /Action executed: click/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Live iframe ref retained', evidence: 'Frame button clicked' } }];
  }];
  await runApplicationAgent({ page, job: { ...job, id: 'agent-stale-live-frame' }, profile, log: () => {} });
  assert.equal(await page.frames()[1].locator('button').innerText(), 'Frame clicked');
  await page.goto(url);
  await page.locator('#submit').evaluate(el => { (el as HTMLButtonElement).type = 'button'; el.addEventListener('click', () => { el.textContent = 'Coordinate clicked'; }); });
  const point = await page.locator('#submit').boundingBox();
  assert.ok(point);
  script = [() => [
    { name: 'browser_action', args: { action: 'click', ref: 'a999999', x: point.x + point.width / 2, y: point.y + point.height / 2 } },
    { name: 'browser_action', args: { action: 'script', ref: 'a999999', script: 'document.querySelector("#name").focus();' } },
    { name: 'browser_action', args: { action: 'press', value: 'A' } },
  ], body => {
    assert.match(observation(body), /Coordinate clicked/);
    return [{ name: 'finish', args: { status: 'skipped', reason: 'Untargeted actions preserved', evidence: 'Coordinate click, script and focused keyboard action worked' } }];
  }];
  await runApplicationAgent({ page, job: { ...job, id: 'agent-stale-untargeted-actions' }, profile, log: () => {} });
  assert.equal(await page.inputValue('#name'), 'A');
  console.log(JSON.stringify({ staleRecoveryMs, staleToolCases: 11, preserved: ['selector waits', 'enabled waits', 'shadow roots', 'radio refs', 'iframe snapshot refs', 'coordinate/script/keyboard actions'] }));

  await page.goto(url);
  const modelFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (...args) => ++requests === 1 ? modelFetch(...args) : new Response('{}', { status: 401 });
  script = [() => [{ name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } }]];
  try {
    await assert.rejects(() => runApplicationAgent({ page, job: { ...job, id: 'agent-provider-failure' }, profile, log: () => {} }), error => {
      assert.equal(applicationFailureContext(error)?.submitPressed, true, 'failure reporting retains possible-send evidence without adding a veto');
      return error instanceof Error && /401/.test(error.message);
    });
  } finally { globalThis.fetch = modelFetch; }
  assert.ok(readFileSync(join(directory, 'traces', 'agent-provider-failure.failures.jsonl'), 'utf8').includes('"submitPressed":true'));
  const maxMs = config.celeris.maxTotalMs;
  config.celeris.maxTotalMs = 1500;
  await page.goto(url);
  script = [() => [{ name: 'browser_action', args: { action: 'script', script: 'async () => new Promise(() => {})' } }]];
  const started = Date.now();
  const timed = await runApplicationAgent({ page, job: { ...job, id: 'agent-script-timeout' }, profile, log: () => {} });
  assert.equal(timed.outcome.status, 'skipped');
  assert.equal(page.isClosed(), true, 'outstanding script cannot continue into the next application');
  assert.ok(Date.now() - started < 8000, 'resource deadline retires an indefinitely pending browser script');
  config.celeris.maxTotalMs = maxMs;
  console.log(`Agent-only ${'Celeris'}: retry/receipt, full evidence, direct scripts, medium/high effort, quota, dry-run and default-account fixtures passed.`);
} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
