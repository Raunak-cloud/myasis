import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';

test('named tools and batches retain real uploads, single sends, Semi-auto approval and audit evidence', { timeout: 60000 }, async () => {
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
    for (const [provider, mode, batched] of [['minimax', '', false], ['minimax', 'prepare', false], ['celeris', '', false], ['celeris', 'prepare', false], ['minimax', '', true]] as const) {
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
        return route.fulfill({ contentType: 'text/html', body: `<main><h1>Fictional Analyst application</h1><form method=post enctype="multipart/form-data" onsubmit="event.preventDefault();const form=this;form.querySelector('[type=file]').files[0].text().then(text=>{sessionStorage.setItem('sent-file',text);form.submit()})"><label>Name<input name=name id=name required></label><label>CV<input type=file name=cv id=cv required></label><button id=send>Submit application</button></form></main>` });
      });
      const page = await context.newPage(), url = `https://named.fixture.invalid/${id}`;
      await page.goto(url);
      const actions = [{ action: 'fill', ref: 'f0', value: 'Alex Fixture' }, { action: 'set_input_files', ref: 'f1', file_ids: ['cv'] }, { action: 'click', selector: '#send', sends_application: true }];
      const calls: Array<{ name: string; args: Record<string, unknown> }> = batched ? [{ name: 'browser_batch', args: { actions } }] : [
        { name: 'browser_navigate', args: { url } },
        { name: 'browser_fill', args: { ref: 'f0' } },
        { name: 'browser_fill', args: { ref: 'f0', value: 'Alex Fixture' } },
        { name: 'browser_upload', args: { ref: 'f1', file_ids: ['cv'] } },
        { name: 'browser_click', args: { selector: '#send', sends_application: true } },
      ];
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
        const call = calls.shift(); assert.ok(call, 'No extra model turns are required');
        // Use the refs from this observation; file controls may use a selector
        // when the form extractor does not assign them a field number.
        const targets = call.name === 'browser_batch' ? call.args.actions as Record<string, unknown>[] : [call.args];
        for (const target of targets) if (target.ref) {
          const selector = target.ref === 'f0' ? '#name' : '#cv';
          const ref = await page.locator(selector).getAttribute('data-field-id');
          if (ref) target.ref = ref;
          else { delete target.ref; target.selector = selector; }
        }
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
      if (!batched) for (const name of ['browser_navigate', 'browser_fill', 'browser_upload', 'browser_click']) assert.ok(steps.some((step: any) => step.tool === name), name);
      await context.close();
    }
  } finally {
    globalThis.fetch = fetchBefore; await browser.close(); closeCelerisQueues();
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-named-browser-')); rmSync(directory, { recursive: true, force: true });
  }
});
