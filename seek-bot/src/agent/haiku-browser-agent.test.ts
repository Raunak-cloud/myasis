/** Native-browser safety integration: real isolated DOM/executor/guards, fictional
 * native Messages responses. Network denied except intercepted .invalid pages.
 * Compile and run dist/agent/haiku-browser-agent.test.js; no paid calls. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';
import type { CelerisReply, ChatMessage } from './celeris.js';
import type { ToolContext } from './tools/context.js';

const owner = `native-agent-fixture-${randomUUID()}`;
const directory = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'data', 'users', owner);
mkdirSync(directory, { recursive: true });
mkdirSync(resolve(directory, 'resumes'));
writeFileSync(resolve(directory, 'resumes', 'Fixture resume.txt'), 'Alex Taylor: fictional customer service experience.');
writeFileSync(resolve(directory, 'resumes.json'), JSON.stringify([{ id: 'fixture-cv', label: 'Approved fictional CV', fileName: 'Fixture resume.txt', seekName: 'Fixture resume.txt', uploadedAt: '2026-01-01T00:00:00Z', size: 60, isDefault: true }]));
Object.assign(process.env, { APPLICATION_AI_MODEL: 'haiku', APPLICATION_AI_ADMIN_ENABLED: 'true', APPLICATION_AI_OWNER_ID: owner,
  ANTHROPIC_API_KEY: 'fictional-native-test-key', OPENROUTER_API_KEY: '', CELERIS_API_KEY: '', DATA_DIR: directory,
  COST_TRACKING: 'false', DRY_RUN: 'true', ALLOW_EXTERNAL_APPLY: 'true', FORM_SPEED_PILOT: 'true',
  HUMANIZER_REQUIRED: 'false', HUMANIZER_MODE: 'off', CAPTCHA_SOLVER: 'off', AGENT_MAX_STEPS: '30', AGENT_MAX_STEPS_PER_PAGE: '12' });
const { runHaikuBrowserApplication, nativeApplicationBatch, nativeApplicationState, nativeApplicationCheckpoint, nativeReceiptCallAllowed, nativeResultDiagnostic } = await import('./haiku-browser-agent.js');
const { HaikuBrowserExecutor, HAIKU_BROWSER_BATCH_HALTED } = await import('./haiku-browser.js');
const { config } = await import('../config.js');
const { haikuMessages } = await import('./haiku.js');
const { gateAdvance } = await import('./tools/gate.js');
const { doFinish } = await import('./tools/finish.js');
const { observe } = await import('./observe.js');
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');
const { applicationFailureContext } = await import('../application-diagnostics.js');
const originalFetch = globalThis.fetch;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
after(async () => { globalThis.fetch = originalFetch; await browser.close(); rmSync(directory, { recursive: true, force: true }); });

const profile = { name: 'Alex Taylor', phone: '', email: 'alex@example.test', suburb: 'Lidcombe', state: 'NSW', nationality: '',
  expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: 'Fictional customer service experience.', skills: [], excludedDomains: [], securityClearance: '' };
type Call = { name: string; input: Record<string, unknown>; custom?: boolean };
type Wire = { tools?: Array<Record<string, unknown>>; messages: Array<{ role: string; content: any }>; output_config?: { format?: { schema?: Record<string, any> } } };
function nativeCall(name: string, input: Record<string, unknown> = {}): Call { return { name, input }; }
function helperCall(name: string, input: Record<string, unknown>): Call { return { name, input, custom: true }; }
function nativeText(body: Wire): string {
  return body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result')
    .flatMap(block => Array.isArray(block.content) ? block.content : []).filter(block => block.type === 'text').map(block => String(block.text)).join('\n');
}
function ref(body: Wire, label: string): string {
  const lines = nativeText(body).split('\n').filter(line => line.includes(label) && /\[ref_\d+\]/.test(line));
  assert.ok(lines.length, `The real native tree must expose ${label}.`);
  return /\[(ref_\d+)\]/.exec(lines.at(-1)!)![1];
}
function mockMessages(plan: (turn: number, body: Wire) => Call[], options: { unknownLicence?: boolean } = {}) {
  const wire: Wire[] = [], reviews: any[] = []; let sequence = 0, turn = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages', 'All Node traffic is intercepted; off-provider traffic is forbidden.');
    const body = JSON.parse(String(init?.body)) as Wire; wire.push(body);
    let content: unknown[], stop = 'end_turn';
    if (body.tools?.some(tool => tool.type === 'browser_toolset_20260801')) {
      const calls = plan(++turn, body); stop = calls.length ? 'tool_use' : 'end_turn';
      content = [{ type: 'thinking', thinking: '', signature: `fictional-native-signature-${turn}` }, ...calls.map(call => ({ type: 'tool_use', id: `fictional-call-${++sequence}`, name: call.name,
        ...(call.custom ? {} : { toolset_name: 'browser' }), input: call.input }))];
      if (!calls.length) content.push({ type: 'text', text: 'Fixture stopped.' });
    } else {
      const schema = body.output_config?.format?.schema;
      assert.ok(schema, 'Shared checks use structured native output.');
      const properties = schema.properties ?? {};
      const prompt = body.messages.map(message => typeof message.content === 'string' ? message.content : message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')).join('\n');
      let answer: unknown;
      if (properties.sends_application) answer = { sends_application: !/"control":"(?:Save draft|Continue)"/.test(prompt) };
      else if (properties.problems) {
        const match = /<untrusted role="current-saved-form">([\s\S]*?)<\/untrusted>/.exec(prompt);
        assert.ok(match, 'The verifier receives a fresh actual saved-form read.');
        const form = JSON.parse(match[1]); reviews.push(form);
        const licence = form.fields.find((field: any) => field.label.includes('Licence number'));
        answer = { problems: options.unknownLicence && licence && !licence.currentValue ? [{ ref: licence.ref, field: licence.label, value: licence.currentValue ?? '', kind: 'needs_candidate', problem: 'The required licence number is not in the fictional candidate evidence.' }] : [] };
      } else if (properties.confirmed) answer = { confirmed: false, quote: '', reason: 'The fictional page has no employer receipt.' };
      else throw new Error(`Unexpected paid-check shape in isolated fixture: ${Object.keys(properties).join(',')}`);
      content = [{ type: 'text', text: JSON.stringify(answer) }];
    }
    return Response.json({ id: `msg_fixture_${sequence}`, model: 'claude-haiku-5-5', role: 'assistant', stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 20 } });
  }) as typeof fetch;
  return { wire, reviews, get turns() { return turn; } };
}
async function fixture(id: string, markup: string) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, serviceWorkers: 'block' });
  const requests: string[] = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url()); requests.push(url.hostname);
    if (url.hostname === 'native-agent.fixture.invalid') return route.fulfill({ contentType: 'text/html', body: markup });
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); await page.goto(`https://native-agent.fixture.invalid/${id}`);
  const job = { id: `fixture-${id}`, title: 'Fictional retail assistant', company: 'Fixture employer', location: 'Sydney NSW', url: page.url(), platform: 'seek' as const, applicationMode: 'external' as const };
  const options = { page, job, profile, simulation: 'isolated-form' as const, log: () => {} };
  const dependencies = { executor: (ctx: ToolContext, settings: ConstructorParameters<typeof HaikuBrowserExecutor>[1]) => new HaikuBrowserExecutor(ctx, { ...settings, resolveHost: async () => ['93.184.216.34'] }), knowledge: async () => 'Fictional candidate evidence only; no licence number or medical declarations supplied.', challenge: async () => true };
  return { page, context, requests, options, dependencies };
}
const form = `<main><h1>Fictional application</h1><label>Full name<input id="name" required></label><label>Approved resume<select id="resume"><option value="fixture-cv">Fixture resume.txt</option></select></label><button id="send" type="button" onclick="this.dataset.sends=String(Number(this.dataset.sends||0)+1)">Submit application</button></main>`;

test('native form_input saves the value; the actual saved-form review runs before dry-run send is withheld', async () => {
  const f = await fixture('dry-run-review', form);
  const mock = mockMessages((turn, body) => turn === 1 ? [nativeCall('read_page', { filter: 'interactive' })]
    : turn === 2 ? [nativeCall('form_input', { target: { type: 'ref', ref: ref(body, 'Full name') }, value: profile.name })]
      : turn === 3 ? [helperCall('application_status', { status: 'in_progress', reason: 'All fictional required facts are available.', no_cover_letter_place: 'The entire fixture has only a name box and final send button.' })]
        : turn === 4 ? [nativeCall('left_click', { target: { type: 'ref', ref: ref(body, 'Submit application') } })] : []);
  try {
    const result = await runHaikuBrowserApplication(f.options, f.dependencies);
    assert.equal(result.outcome.status, 'rehearsed'); assert.equal(result.submitPressed, false);
    assert.equal(await f.page.locator('#name').inputValue(), profile.name);
    assert.equal(await f.page.locator('#send').getAttribute('data-sends'), null);
    assert.equal(mock.reviews.length, 1); assert.equal(mock.reviews[0].fields.find((field: any) => field.label === 'Full name').currentValue, profile.name);
    assert.ok(mock.wire.some(body => body.messages.some(message => Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_result' && block.toolset_name === 'browser'))));
    assert.ok(f.requests.every(host => host.endsWith('.invalid')));
  } finally { await f.context.close(); }
});

test('a required unknown licence is held by the actual saved-form reviewer without inventing an answer', async () => {
  const f = await fixture('unknown-licence', form.replace('<input id="name" required>', `<input id="name" required value="${profile.name}">`) + '<label>Licence number<input id="licence" required></label>');
  const mock = mockMessages((turn, body) => turn === 1 ? [nativeCall('read_page', { filter: 'interactive' })]
    : turn === 2 ? [helperCall('application_status', { status: 'in_progress', reason: 'Inspect the actual form before attempting send.', no_cover_letter_place: 'No letter field exists in this complete fixture.' })]
      : turn === 3 ? [nativeCall('left_click', { target: { type: 'ref', ref: ref(body, 'Submit application') } })] : [], { unknownLicence: true });
  try {
    const result = await runHaikuBrowserApplication(f.options, f.dependencies);
    assert.equal(result.outcome.status, 'needs-human'); assert.match(JSON.stringify(result.outcome), /Licence number/);
    assert.equal(result.submitPressed, false); assert.equal(await f.page.locator('#licence').inputValue(), '');
    assert.equal(await f.page.locator('#send').getAttribute('data-sends'), null); assert.equal(mock.reviews.length, 1);
  } finally { await f.context.close(); }
});

test('an actual native batch failure halts every later browser/custom call and retains each namespace', async () => {
  const f = await fixture('batch-halt', form); const ctx = { page: f.page } as ToolContext;
  const executor = new HaikuBrowserExecutor(ctx, { ownerDataDir: directory, resolveHost: async () => ['93.184.216.34'], beforeMutation: async () => {} });
  try {
    const tree = await executor.execute('read_page', { filter: 'interactive' });
    const value = tree.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const nameRef = /\[(ref_\d+)\]/.exec(value.split('\n').find(line => line.includes('Full name'))!)![1];
    const calls: CelerisReply['toolCalls'] = [{ id: 'bad', name: 'form_input', toolset_name: 'browser', args: { target: { type: 'ref', ref: 'ref_999999' }, value: 'Bad' } },
      { id: 'later', name: 'form_input', toolset_name: 'browser', args: { target: { type: 'ref', ref: nameRef }, value: 'Must not execute' } }, { id: 'helper', name: 'candidate_evidence', args: { query: 'Not executed' } }];
    const assistant: ChatMessage = { role: 'assistant', content: null, anthropic_content: calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args, ...(call.toolset_name ? { toolset_name: call.toolset_name } : {}) })) };
    let executed = 0;
    const result = await nativeApplicationBatch({ text: '', message: assistant, toolCalls: calls }, async call => { executed++; return executor.execute(call.name, call.args); });
    assert.equal(executed, 1); assert.equal(await f.page.locator('#name').inputValue(), ''); assert.equal(result.messages.length, 3);
    assert.deepEqual(result.messages.map(message => message.role === 'tool' ? message.toolset_name : undefined), ['browser', 'browser', undefined]);
    for (const message of result.messages.slice(1)) { assert.equal(message.role, 'tool'); if (message.role === 'tool') { assert.equal(message.is_error, true); assert.deepEqual(message.anthropic_content, [{ type: 'text', text: HAIKU_BROWSER_BATCH_HALTED }]); } }
    assert.equal(haikuMessages([{ role: 'user', content: 'Fictional batch.' }, assistant, ...result.messages]).messages.length, 3);
  } finally { await executor.dispose(); await f.context.close(); }
});

test('after a simulated possible final send the application loop blocks another click and tab switch', async () => {
  const f = await fixture('uncertain-send', form.replace('Submit application', 'Save draft'));
  const calls: string[] = []; let marked = false;
  const mock = mockMessages((turn, body) => turn === 1 ? [nativeCall('read_page', { filter: 'interactive' })]
    : turn === 2 ? [nativeCall('left_click', { target: { type: 'ref', ref: ref(body, 'Save draft') } })]
      : turn === 3 ? [nativeCall('switch_tab', { tab_id: 'tab-1' })]
        : [nativeCall('left_click', { target: { type: 'ref', ref: ref(body, 'Save draft') } })]);
  try {
    const result = await runHaikuBrowserApplication(f.options, { ...f.dependencies, executor: (ctx, settings) => {
      const real = new HaikuBrowserExecutor(ctx, { ...settings, resolveHost: async () => ['93.184.216.34'] });
      return { registerDocument: real.registerDocument.bind(real), dispose: real.dispose.bind(real), execute: async (name, input) => {
        calls.push(name); const answer = await real.execute(name, input);
        // Trusted fixture simulates an uncertain send boundary after one actual
        // local click. No employer request is possible and dry-run remains true.
        if (!marked && name === 'left_click' && !answer.is_error) { marked = true; ctx.submissionAttempted = true; }
        return answer;
      } };
    } });
    assert.equal(marked, true); assert.equal(result.submitPressed, true); assert.notEqual(result.outcome.status, 'applied');
    assert.equal(await f.page.locator('#send').getAttribute('data-sends'), '1');
    assert.equal(calls.filter(name => name === 'left_click').length, 1); assert.equal(calls.includes('switch_tab'), false);
    assert.ok(mock.turns <= 5, 'Unconfirmed sends get a bounded observation window.');
  } finally { await f.context.close(); }
});

test('native references and repeated reads do not create saved-state progress or replenish page budgets', async () => {
  const f = await fixture('read-only-loop', form), ctx = { page: f.page } as ToolContext;
  const executor = new HaikuBrowserExecutor(ctx, { ownerDataDir: directory, resolveHost: async () => ['93.184.216.34'], beforeMutation: async () => {} });
  try {
    const before = await nativeApplicationState(ctx); await executor.execute('read_page', { filter: 'interactive' });
    await executor.execute('read_page', { filter: 'interactive' }); assert.equal(await nativeApplicationState(ctx), before);
  } finally { await executor.dispose(); }
  const previous = config.celeris.maxStepsPerPage; config.celeris.maxStepsPerPage = 4;
  const mock = mockMessages(() => [nativeCall('read_page', { filter: 'interactive' })]);
  try {
    const result = await runHaikuBrowserApplication(f.options, f.dependencies);
    assert.equal(result.outcome.status, 'skipped'); assert.equal(result.steps, 5); assert.equal(mock.turns, 5); assert.equal(result.submitPressed, false);
  } finally { config.celeris.maxStepsPerPage = previous; await f.context.close(); }
});

test('native reads never expose hidden label text or protected code values', async () => {
  const f = await fixture('private-labels', '<main><label for="name">Full name<span hidden>HIDDEN_LABEL_PRIVATE</span></label><input id="name"><label for="code">Verification code<span hidden>HIDDEN_AUTH_LABEL_PRIVATE</span></label><input id="code" autocomplete="one-time-code" value="FICTIONAL_PROTECTED_CODE"></main>');
  const executor = new HaikuBrowserExecutor({ page: f.page } as ToolContext, { ownerDataDir: directory, resolveHost: async () => ['93.184.216.34'], beforeMutation: async () => {} });
  try {
    const read = await executor.execute('read_page', { filter: 'all' });
    assert.equal(read.is_error, undefined);
    assert.doesNotMatch(JSON.stringify(read.content), /HIDDEN_LABEL_PRIVATE|HIDDEN_AUTH_LABEL_PRIVATE|FICTIONAL_PROTECTED_CODE/);
  } finally { await executor.dispose(); await f.context.close(); }
});

test('fresh checkpoints retain verified state and submission uncertainty without signed history or URL secrets', async () => {
  const f = await fixture('checkpoint?token=FICTIONAL_URL_SECRET#FICTIONAL_HASH_SECRET', form.replace('<input id="name" required>', `<input id="name" required value="${profile.name}">`));
  const initial: ChatMessage[] = [{ role: 'system', content: 'Immutable fictional native policy.' }, { role: 'user', content: 'Immutable authorised vacancy and candidate evidence.' }];
  const before = structuredClone(initial);
  const ctx = { page: f.page, submissionAttempted: true, resumeUsed: 'Approved fictional CV', resumeName: 'Fixture resume.txt', resumeSettled: true, guards: { ungrounded: ['Licence number'] } } as unknown as ToolContext;
  try {
    const checkpoint = await nativeApplicationCheckpoint(ctx, initial, { kind: 'ok', message: 'The CURRENT saved form is not ready: one required unknown.' });
    assert.deepEqual(initial, before); assert.deepEqual(checkpoint.slice(0, 2), before); assert.equal(checkpoint.length, 3);
    assert.equal(checkpoint.some(message => message.role === 'assistant' || message.role === 'tool'), false);
    assert.match(JSON.stringify(checkpoint), /possibleSubmission\\?":true/); assert.match(JSON.stringify(checkpoint), /Alex Taylor/);
    assert.match(JSON.stringify(checkpoint), /Licence number/); assert.match(JSON.stringify(checkpoint), /Only observe this current tab/);
    assert.doesNotMatch(JSON.stringify(checkpoint), /FICTIONAL_URL_SECRET|FICTIONAL_HASH_SECRET|anthropic_content|signature/);
  } finally { await f.context.close(); }
});

test('receipt-only policy pins the current tab and permits only verified submission intent', () => {
  const call = (name: string, args: Record<string, unknown> = {}, browser = true): CelerisReply['toolCalls'][number] => ({ id: 'fixture', name, args, ...(browser ? { toolset_name: 'browser' as const } : {}) });
  assert.equal(nativeReceiptCallAllowed(call('read_page')), true);
  assert.equal(nativeReceiptCallAllowed(call('screenshot', { tab_id: 'receipt' }), 'receipt'), true);
  assert.equal(nativeReceiptCallAllowed(call('read_page', { tab_id: 'other' }), 'receipt'), false);
  assert.equal(nativeReceiptCallAllowed(call('switch_tab', { tab_id: 'receipt' }), 'receipt'), false);
  for (const name of ['left_click', 'form_input', 'navigate', 'scroll', 'hover', 'new_tab']) assert.equal(nativeReceiptCallAllowed(call(name)), false);
  assert.equal(nativeReceiptCallAllowed(call('candidate_evidence', { query: 'Unneeded' }, false)), false);
  assert.equal(nativeReceiptCallAllowed(call('application_status', { status: 'submitted' }, false)), true);
  assert.equal(nativeReceiptCallAllowed(call('application_status', { status: 'in_progress' }, false)), false);
});

test('failure diagnostics contain only fixed classes and no page/private values', () => {
  const secret = 'FICTIONAL_PRIVATE_VALUE';
  assert.equal(nativeResultDiagnostic({ content: [{ type: 'text', text: `No approved resume is available: ${secret}` }], is_error: true }), 'approved-resume-unavailable');
  assert.equal(nativeResultDiagnostic({ content: [{ type: 'text', text: `Unexpected site text ${secret}` }], is_error: true }), 'native-execution-error');
  assert.doesNotMatch(nativeResultDiagnostic({ content: [{ type: 'text', text: `Required unknown ${secret}` }], is_error: true }), new RegExp(secret));
});

test('native shared guards never select a board resume or scroll/reveal controls as a side effect', async t => {
  globalThis.fetch = (async () => { throw new Error('This read-only guard regression must not need a provider.'); }) as typeof fetch;
  for (const board of ['https://www.seek.com.au/job/12345678', 'https://au.indeed.com/viewjob?jk=fixture']) {
    const f = await fixture(`native-guard-${board.includes('seek') ? 'seek' : 'indeed'}`, '<main><label>Resume<select id="resume"><option value="other">Other CV.txt</option><option value="approved">Fixture resume.txt</option></select></label><details id="docs"><summary>Supporting documents</summary><input type="file"></details><button id="edit" onclick="this.dataset.clicked=\"yes\"">Edit resume</button><div style="height:2000px"></div><p>Cover letter</p></main>');
    // Only the guard's board identity is substituted. The real browser remains
    // on an intercepted .invalid origin and every DOM read is genuine.
    t.mock.method(f.page, 'url', () => board);
    const ctx = { page: f.page, job: f.options.job, profile, nativeBrowserActionsOnly: true,
      guards: new RunGuards({ maxSteps: 20, maxStepsPerPage: 8, maxStuckMs: 30000, maxTotalMs: 60000, meter: new CostMeter(1) }),
      observation: await observe(f.page), captured: [{ question: 'Full name', answer: profile.name }], actions: [], log: () => {} } as ToolContext;
    try {
      const gate = await gateAdvance(ctx, 'Continue');
      assert.equal(gate.proceed, false);
      if (!gate.proceed && gate.result.kind === 'ok') assert.match(gate.result.message, /native browser controls/);
      assert.equal(await f.page.locator('#resume').inputValue(), 'other');
      assert.equal(await f.page.locator('#docs').getAttribute('open'), null); assert.equal(await f.page.locator('#edit').getAttribute('data-clicked'), null);
      ctx.resumeSettled = true;
      await gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true });
      assert.equal(await f.page.evaluate(() => scrollY), 0, 'Cover-letter inspection must not scroll behind the native controller.');
      const ending = await doFinish(ctx, { status: 'cannot_complete', reason: 'The fictional CAPTCHA could not be completed.' });
      assert.equal(ending.kind, 'terminal'); assert.equal(await f.page.evaluate(() => scrollY), 0, 'Status intent must not trigger the legacy CAPTCHA scrolling helper.');
      assert.equal(await f.page.locator('#resume').inputValue(), 'other'); assert.equal(await f.page.locator('#docs').getAttribute('open'), null);
      await f.page.setContent(`<main><h1>Early application step</h1><label>Full name<input value="${profile.name}" required></label><button type="button">Continue</button></main>`);
      ctx.resumeSettled = false; ctx.observation = await observe(f.page);
      mockMessages(() => []);
      const early = await gateAdvance(ctx, 'Continue');
      assert.equal(early.proceed, true, 'An early step without resume controls must not be held for an unseen document step.');
      if (early.proceed) assert.equal(early.submit, false);
    } finally { await f.context.close(); }
  }
});

test('weak receipt-looking text cannot produce an unverified application success', async () => {
  const f = await fixture('weak-receipt', '<main><h1>Application received</h1><p>This fictional generic text does not identify the authorised vacancy or a receipt.</p></main>');
  const mock = mockMessages(() => [helperCall('application_status', { status: 'cannot_complete', reason: 'No verified job-specific receipt is available.' })]);
  try {
    const result = await runHaikuBrowserApplication(f.options, f.dependencies);
    assert.notEqual(result.outcome.status, 'applied'); assert.equal(result.submitPressed, false);
    assert.ok(mock.wire.some(body => body.output_config?.format?.schema?.properties?.confirmed), 'The weak marker must reach the independent receipt verifier.');
  } finally { await f.context.close(); }
});

test('a provider exception after a simulated possible send preserves uncertain-send diagnostics', async () => {
  const f = await fixture('post-send-provider-error', form.replace('Submit application', 'Save draft'));
  const failure = new Error('Fictional provider exception after possible send.'); let marked = false;
  mockMessages((turn, body) => {
    if (turn === 1) return [nativeCall('read_page', { filter: 'interactive' })];
    if (turn === 2) return [nativeCall('left_click', { target: { type: 'ref', ref: ref(body, 'Save draft') } })];
    throw failure;
  });
  try {
    await assert.rejects(() => runHaikuBrowserApplication(f.options, { ...f.dependencies, executor: (ctx, settings) => {
      const real = new HaikuBrowserExecutor(ctx, { ...settings, resolveHost: async () => ['93.184.216.34'] });
      return { registerDocument: real.registerDocument.bind(real), dispose: real.dispose.bind(real), execute: async (name, input) => {
        const answer = await real.execute(name, input);
        if (name === 'left_click' && !answer.is_error) { marked = true; ctx.submissionAttempted = true; }
        return answer;
      } };
    } }), (error: unknown) => error === failure && applicationFailureContext(error)?.submitPressed === true);
    assert.equal(marked, true); assert.equal(await f.page.locator('#send').getAttribute('data-sends'), '1');
  } finally { await f.context.close(); }
});
