import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
import { namedBrowserToolCall } from './browser-tools.js';
import { toolInputIssue } from './tool-input.js';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';

test('named tools and batches retain real controls, uploads, single sends, Semi-auto approval and audit evidence', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-named-browser-'));
  const environment = { ...process.env }, fetchBefore = globalThis.fetch;
  Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', OPENROUTER_API_KEY: 'fixture-only',
    CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'), CELERIS_MIN_INTERVAL_MS: '0', DRY_RUN: 'false',
    ALLOW_EXTERNAL_APPLY: 'true', COST_TRACKING: 'false', FORM_CORPUS_DIR: join(directory, 'corpus'), APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false' });
  mkdirSync(join(directory, 'resumes')); writeFileSync(join(directory, 'resumes/CV.txt'), 'Original fictional CV bytes');
  writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'cv', label: 'Fixture CV', fileName: 'CV.txt' }]));
  const { runAgentOnlyApplication } = await import('./agent-only.js');
  const { withApplicationModel } = await import('../application-model.js');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    for (const [provider, mode, batched] of [['minimax', '', false], ['minimax', 'prepare', false], ['celeris', '', false], ['celeris', 'prepare', false], ['minimax', '', true], ['celeris', '', true], ['minimax', 'prepare', true]] as const) {
      process.env.APPLICATION_REVIEW_MODE = mode;
      const id = `${provider}-${mode || 'auto'}-${batched ? 'batch' : 'named'}`, receipt = `Application received: ${id}`;
      const context = await browser.newContext();
      let sends = 0, submitted = '';
      await context.route('**/*', async route => {
        if (!new URL(route.request().url()).hostname.endsWith('.invalid')) return route.abort();
        if (route.request().method() === 'POST') {
          sends++; submitted = route.request().postData() ?? '';
          return route.fulfill({ contentType: 'text/html', body: `<main><h1>${receipt}</h1></main>` });
        }
        return route.fulfill({ contentType: 'text/html', body: `<main><h1>Fictional Analyst application</h1><form method=post enctype="multipart/form-data" onsubmit="event.preventDefault();const form=this;form.querySelector('[type=file]').files[0].text().then(text=>{sessionStorage.setItem('sent-file',text);form.submit()})"><label>Name<input name=name id=name required></label><label>CV<input type=file name=cv id=cv required></label><section id=questions><label>Right to work<select id=country name=country required><option value="">Choose</option><option value=AU>Australian citizen</option></select></label><fieldset><legend>Do you have Wireframing experience?</legend><label><input type=radio id=wireyes name=wire value=Yes checked>Yes</label><label><input type=radio id=wireno name=wire value=No>No</label></fieldset><label><input id=consent type=checkbox name=consent required>Accept application terms</label><label><input id=updates type=checkbox name=updates checked>Send optional updates</label></section><button id=send>Submit application</button></form></main>` });
      });
      const page = await context.newPage(), url = `https://named.fixture.invalid/${id}`;
      await page.goto(url);
      const actions = [{ action: 'fill', selector: '#name', value: 'Alex Fixture' }, { action: 'set_input_files', selector: '#cv', file_ids: ['cv'] },
        {action:'select',selector:'#country',value:'Australian citizen'}, {action:'check',selector:'#wireno',value:'true'},
        {action:'check',selector:'#consent',value:'true'}, {action:'check',selector:'#updates',value:'false'},
        { action: 'click', selector: '#send', sends_application: true }];
      const calls: Array<{ name: string; args: Record<string, unknown> }> = batched ? [{ name: 'browser_batch', args: { actions: actions.map(action => {const call=namedBrowserToolCall('browser_action',action);return {tool:call.name,args:call.args};}) } }] : [
        { name: 'browser_navigate', args: { url } },
        { name: 'browser_fill', args: { ref: 'f0' } },
        { name: 'browser_fill', args: { ref: 'f0', value: 'Alex Fixture' } },
        { name: 'browser_upload', args: { ref: 'f1', file_ids: ['cv'] } },
        { name: 'fill_authentication_fields', args: {purpose:'sign_in',reason:'Controlled wrong-tool recovery fixture',targets:[{selector:'#country'}]} },
        { name: 'browser_select_dropdown', args: {selector:'#country',option:'Australian citizen'} },
        { name: 'browser_choose_radio', args: {selector:'#wireno'} },
        { name: 'browser_set_checkbox', args: {selector:'#consent',checked:true} },
        { name: 'browser_set_checkbox', args: {selector:'#updates',checked:false} },
        { name: 'browser_press_key', args: {selector:'#name',key:'Tab',sends_application:false} },
        { name: 'browser_inspect', args: {selector:'#country'} },
        { name: 'browser_snapshot', args: {selector:'#questions'} },
        { name: 'browser_click', args: { selector: '#send', sends_application: true } },
      ];
      if (!mode && !batched) calls.splice(calls.length-1,0,{name:'browser_run_script',args:{script:'return document.querySelector("#country").value',script_intent:'inspect'}});
      if (!mode) calls.push({ name: 'finish', args: { status: 'applied', reason: receipt, evidence: receipt, receipt: { quote: receipt } } });
      let previous = '';
      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        assert.ok(body.tools?.some((tool: any) => tool.function.name === 'browser_upload'));
        if (provider === 'minimax') assert.equal(body.reasoning.effort, 'high');
        if (previous === 'invalid-fill') {
          assert.equal(await page.locator('#name').inputValue(), '', 'A missing value cannot silently clear or change the field');
          assert.match(body.messages.filter((message: any) => message.role === 'tool').at(-1).content, /value is required/);
        }
        if(previous==='fill_authentication_fields')assert.match(body.messages.filter((m:any)=>m.role==='tool').at(-1).content,/browser_select_dropdown and option/);
        if(previous==='browser_snapshot'){
          assert.equal(await page.locator('#country').inputValue(),'AU');
          assert.equal(await page.locator('#wireno').isChecked(),true);
          assert.equal(await page.locator('#wireyes').isChecked(),false);
          assert.equal(await page.locator('#consent').isChecked(),true);
          assert.equal(await page.locator('#updates').isChecked(),false);
        }
        const call = calls.shift(); assert.ok(call, 'No extra model turns are required');
        // Use the refs from this observation; file controls may use a selector
        // when the form extractor does not assign them a field number.
        const targets = call.name === 'browser_batch' ? (call.args.actions as Array<{args:Record<string,unknown>}>).map(action=>action.args) : [call.args];
        if (batched) for (const target of targets) if (target.selector) {
          const node=page.locator(String(target.selector));
          const ref=await node.getAttribute('data-field-id')??await node.getAttribute('data-ref-id');
          assert.ok(ref, 'Normal batch controls have current refs'); delete target.selector;target.ref=ref;
        }
        for (const target of targets) if (target.ref) {
          if (batched) continue;
          const selector = target.ref === 'f0' ? '#name' : '#cv';
          const ref = await page.locator(selector).getAttribute('data-field-id');
          if (ref) target.ref = ref;
          else { delete target.ref; target.selector = selector; }
        }
        if(batched)assert.equal(toolInputIssue(call.args,body.tools.find((tool:any)=>tool.function.name===call.name).function.parameters),null);
        previous = call.name === 'browser_fill' && call.args.value === undefined ? 'invalid-fill' : call.name;
        return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
      }) as typeof fetch;
      const result = await withApplicationModel({ ...process.env, APPLICATION_AI_MODEL: provider }, () => runAgentOnlyApplication({ page,
        profile: { name: 'Alex Fixture', email: 'alex@fixture.invalid', skills: [] } as never,
        job: { id, title: 'Fictional Analyst', company: 'Fictional Employer', location: 'Sydney', url, platform: 'indeed' }, log: () => {} }));
      assert.equal(calls.length, 0);
      assert.equal(result.outcome.status, mode ? 'prepared' : 'applied');
      assert.equal(sends, mode ? 0 : 1, 'Semi-auto prepares; Auto sends exactly once');
      if (!mode) {
        for (const text of ['Alex Fixture', 'CV.txt']) assert.ok(submitted.includes(text), text);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('sent-file')), 'Original fictional CV bytes');
      }
      const trace = JSON.parse(readFileSync(join(directory, 'traces', `${id}.json`), 'utf8'));
      const steps = trace.steps ?? trace.trace;
      assert.ok(Array.isArray(steps));
      if (!batched) for (const name of ['browser_navigate', 'browser_fill', 'browser_upload', 'browser_select_dropdown','browser_choose_radio','browser_set_checkbox','browser_press_key','browser_inspect','browser_snapshot','browser_click']) assert.ok(steps.some((step: any) => step.tool === name), name);
      await context.close();
    }
  } finally {
    globalThis.fetch = fetchBefore; await browser.close(); closeCelerisQueues();
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-named-browser-')); rmSync(directory, { recursive: true, force: true });
  }
});
