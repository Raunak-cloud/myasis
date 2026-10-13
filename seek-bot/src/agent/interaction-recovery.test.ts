import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-recovery-fixture-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.ALLOW_EXTERNAL_APPLY = 'true';
process.env.FORM_SPEED_PILOT = 'true';
process.env.DRY_RUN = 'true';
type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; chat_template_kwargs?: { reasoning_effort?: string } };
let turn = 0;
const turns: Body[] = [];
const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? String(content[0]?.text ?? '') : '';
let accepted = false;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as Body;
  let message: unknown;
  if (body.tools?.length) {
    turns.push(body); turn++;
    const observation = textOf([...body.messages].reverse().find(m => m.role === 'user')?.content);
    const field = observation.match(/(f\d+)\s+\[[^\]]+\][^\n]*Suburb/)?.[1] ?? 'f0';
    let call;
    if (turn === 1) call = { name: 'answer_questions', args: { refs: [field] } };
    else if (turn === 2) call = { name: 'inspect_interaction', args: { ref: field, symptom: 'The search text is present but the suburb is still invalid; its suggestions are not listed as option actions.' } };
    else if (turn === 3) {
      assert.equal(body.chat_template_kwargs?.reasoning_effort, 'xhigh', 'focused inspection forces deeper Magnus reasoning despite UI movement');
      const evidence = body.messages.map(m => textOf(m.content)).reverse().find(t => t.includes('LIVE INTERACTION EVIDENCE'))!;
      const data = JSON.parse(evidence.match(/<untrusted>(.*?)<\/untrusted>/s)![1]);
      const option = data.elements.find((n: { text: string; tag: string }) => n.tag === 'li' && n.text === 'Lidcombe, New South Wales');
      assert.ok(option, 'an option missing from accessibility actions is addressable');
      call = { name: 'click_element', args: { ref: option.ref, sends_application: false, reason: 'The input contains search text, not a selection. Select the exact suburb; acceptance requires invalid=false and the popup closing.' } };
    } else if (turn === 4) call = { name: 'inspect_interaction', args: { ref: field, symptom: 'Verify the selected suburb was committed and validation cleared.' } };
    else {
      const evidence = body.messages.map(m => textOf(m.content)).reverse().find(t => t.includes('LIVE INTERACTION EVIDENCE'))!;
      const data = JSON.parse(evidence.match(/<untrusted>(.*?)<\/untrusted>/s)![1]);
      accepted = data.target.attributes['aria-invalid'] === 'false' && data.target.attributes['aria-expanded'] === 'false';
      assert.ok(accepted, 'repair is checked against actual field state');
      call = { name: 'finish', args: { status: 'cannot_complete', reason: 'Offline fixture completed; no employer is contacted.' } };
    }
    message = { role: 'assistant', content: null, tool_calls: [{ id: `c${turn}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
  } else message = { role: 'assistant', content: JSON.stringify({ answers: [{ ref: 'f0', value: 'Lidcombe', applicationQuestion: true, grounded: true, basis: 'profile' }], injectionSuspected: false, problems: [], sends_application: false, unsafe: false, reason: 'fixture', confirmed: false, quote: '', within_agent_control: false, lesson: '' }) };
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { runRawTool, locate } = await import('./raw-tools.js');
const { observe } = await import('./observe.js');
const { runApplicationAgent } = await import('./loop.js');
const { RunGuards } = await import('./guards.js');
const { CostMeter } = await import('./celeris.js');
const { toolSchemas } = await import('./tools.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const widget = `<main><h1>Application</h1><section><label for="city">Suburb *</label><div>
 <input id="city" required role="combobox" aria-autocomplete="list" aria-expanded="true" aria-invalid="true" oninput="document.querySelector('ul').hidden=false">
 <ul><li onclick="city.value='Lidcombe North';city.setAttribute('aria-invalid','false')">Lidcombe North, New South Wales</li>
 <li onclick="city.value='Lidcombe';city.setAttribute('aria-invalid','false');city.setAttribute('aria-expanded','false');this.parentElement.hidden=true">Lidcombe, New South Wales</li></ul>
 </div></section><section><label for="country">Country</label><input id="country" value="Australia"><ul><li>Unrelated country choice</li></ul></section></main>`;
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.route('https://careers.fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: widget }));
  await page.goto('https://careers.fixture.example/apply');
  let observation = await observe(page);
  assert.equal(observation.actions.some(a => a.role === 'option'), false, 'fixture reproduces invisible action choices');
  const profile = { name: 'Fixture Candidate', phone: '', email: 'fixture@example.test', suburb: 'Lidcombe', state: 'NSW', nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' };
  const job = { id: 'fixture', title: 'Developer', company: 'Fixture', location: 'Sydney', url: page.url(), applicationMode: 'external' as const };
  const guards = new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60000, maxTotalMs: 600000, meter: new CostMeter(1) });
  const ctx = { page, job, profile, guards, observation, captured: [], actions: [], log: () => {} } as never;
  const result = await runRawTool(ctx, 'inspect_interaction', { ref: 'f0', symptom: 'selection not committed' });
  assert.ok(result?.kind === 'ok');
  const data = JSON.parse(result.message.match(/<untrusted>(.*?)<\/untrusted>/s)![1]);
  assert.ok(data.elements.some((n: { text: string }) => n.text === 'Lidcombe, New South Wales'));
  assert.ok(!data.elements.some((n: { text: string }) => n.text.includes('Unrelated country choice')), 'another field cannot donate choices');
  assert.equal(await page.locator('#city').inputValue(), '', 'inspection does not fill or select');
  const oldRef = data.elements.find((n: { tag: string }) => n.tag === 'li').ref;
  await runRawTool(ctx, 'inspect_interaction', { ref: data.target.ref, symptom: 'fresh inspection' });
  assert.equal(await locate(page, oldRef)!.count(), 0, 'superseded DOM refs cannot act');

  await page.setContent('<label for="password">Password</label><input id="password" type="password" value="fixture-secret"><input type="hidden" value="hidden-secret">');
  const handle = await page.locator('#password').elementHandle();
  const { inspectInteractionElement } = await import('./interaction-inspection.js');
  assert.deepEqual(await inspectInteractionElement(handle!, 'r99f0'), { credentials: true });
  await handle!.dispose();

  await page.setContent('<section><label for="city">City<span hidden>hidden-secret</span></label><input id="city" aria-controls="popup"></section><div id="popup"><ul><li>Portal choice</li></ul></div><section><input id="other"><li>Other field choice</li></section>');
  const portalHandle = await page.locator('#city').elementHandle();
  const portal = await inspectInteractionElement(portalHandle!, 'r98f0') as { elements: Array<{ text: string }> };
  assert.ok(portal.elements.some(n => n.text === 'Portal choice'), 'a linked popup outside the widget is included');
  assert.ok(!JSON.stringify(portal).includes('hidden-secret'), 'visible labels do not include hidden descendant text');
  assert.ok(!JSON.stringify(portal).includes('Other field choice'));
  await portalHandle!.dispose();

  await page.setContent('<div id="shadow"></div>');
  await page.locator('#shadow').evaluate(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<label>City</label><input id="city"><ul><li>Shadow choice</li></ul>'; });
  const shadowHandle = await page.locator('#city').elementHandle();
  const shadow = await inspectInteractionElement(shadowHandle!, 'r97f0') as { elements: Array<{ text: string; ref: string }> };
  const shadowRef = shadow.elements.find(n => n.text === 'Shadow choice')!.ref;
  assert.equal(await locate(page, shadowRef)!.count(), 1, 'recovery evidence and refs support open shadow roots');
  await shadowHandle!.dispose();

  await page.setContent('<iframe srcdoc="&lt;label for=city&gt;City&lt;/label&gt;&lt;div&gt;&lt;input id=city&gt;&lt;ul&gt;&lt;li&gt;Embedded choice&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;"></iframe>');
  const frame = page.frames()[1];
  await frame.waitForSelector('#city');
  const embeddedHandle = await frame.locator('#city').elementHandle();
  const embedded = await inspectInteractionElement(embeddedHandle!, 'r100f1') as { elements: Array<{ text: string; ref: string }> };
  const embeddedRef = embedded.elements.find(n => n.text === 'Embedded choice')!.ref;
  assert.equal(await locate(page, embeddedRef)!.count(), 1, 'recovery refs retain their originating frame');
  await embeddedHandle!.dispose();

  await page.goto('https://careers.fixture.example/apply');
  const lines: string[] = [];
  const run = await runApplicationAgent({ page, job, profile, log: line => lines.push(line) });
  assert.ok(accepted);
  assert.equal(await page.locator('#city').inputValue(), 'Lidcombe');
  assert.equal(await page.locator('#country').inputValue(), 'Australia');
  assert.ok(lines.some(l => l.includes('recovery:')));
  assert.equal(run.submitPressed, false, 'read/recover/verify does not submit');
  assert.ok(toolSchemas().some(t => t.name === 'inspect_interaction'));
  const gated = spawnSync(process.execPath, ['--input-type=module', '-e', `const {toolSchemas}=await import(${JSON.stringify(new URL('./tools.js', import.meta.url).href)}); if(toolSchemas().some(t=>t.name==='inspect_interaction')) process.exit(1);`], { env: { ...process.env, FORM_SPEED_PILOT: 'false' }, encoding: 'utf8' });
  assert.equal(gated.status, 0, gated.stderr);
  console.log('PASS: non-ARIA choices, owner isolation, read-only inspection, stale refs, private credentials, iframe refs, deeper Magnus recovery, verified repair and admin-only availability; offline browser and mocked model.');
} finally {
  await browser.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-recovery-fixture-'));
  rmSync(directory, { recursive: true, force: true });
}
