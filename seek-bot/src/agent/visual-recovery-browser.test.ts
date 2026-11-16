import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'patchright';
import { withApplicationModel } from '../application-model.js';
const directory = mkdtempSync(join(tmpdir(), 'visual-recovery-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', OPENROUTER_API_KEY: 'fixture-only', DRY_RUN: 'true', COST_TRACKING: 'false', ALLOW_EXTERNAL_APPLY: 'true', FORM_CORPUS_DIR: join(directory, 'corpus') });
const { runApplicationAgent } = await import('./loop.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch;
try {
  for (const scenario of ['invalid-recover', 'invalid-stall', 'no-change-recover', 'execution-recover']) {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Fictional application</h1><label>Institution<input id="institution" required></label><button id="noop">Inspect again</button></main>' }));
    const page = await context.newPage(), url = `https://visual.fixture.invalid/${scenario}`;
    await page.goto(url);
    let turns = 0, sawRecovery = false;
    const triggerTurn = scenario === 'no-change-recover' ? 3 : 2;
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const latest = request.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
      const text = typeof latest.content === 'string' ? latest.content : latest.content.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('');
      const images = Array.isArray(latest.content) ? latest.content.filter((part: { type: string }) => part.type === 'image_url') : [];
      const current = turns++;
      if (current === triggerTurn) {
        assert.equal(images.length, 1, 'stalled MiniMax receives a fresh screenshot');
        assert.match(text, /VISUAL RECOVERY/); assert.match(text, /Recent action results/);
        assert.ok(request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'browser_fill'));
        assert.ok(request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'browser_action'), 'the formerly failing tool is not locked');
        sawRecovery = true;
      }
      let call;
      if (current < triggerTurn || scenario === 'invalid-stall') call = scenario === 'no-change-recover'
        ? { name: 'browser_click', args: { selector: '#noop', sends_application: false } }
        : { name: 'browser_action', args: scenario === 'execution-recover' ? { action: 'script', script: 'throw new Error("fixture execution failure")', script_intent: 'inspect' } : { action: 'script', script_intent: 'inspect' } };
      else if (current === triggerTurn) call = { name: 'browser_fill', args: { selector: '#institution', value: 'SHIATS' } };
      else call = { name: 'finish', args: { status: 'skipped', reason: 'Fictional visual recovery check complete.', evidence: 'Institution value was filled after screenshot recovery.' } };
      assert.ok(current < 6, 'no unbounded recovery loop');
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `${scenario}-${current}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    }) as typeof fetch;
    const result = await withApplicationModel({ ...process.env, APPLICATION_AI_MODEL: 'minimax' }, () => runApplicationAgent({ page, simulation: 'isolated-form', job: { id: scenario, title: 'Analyst', company: 'Fixture', location: 'Sydney', url }, profile: { name: 'Alex Fixture', email: 'fixture@example.invalid', skills: [], suburb: 'Sydney' } as never, log: () => {} }));
    assert.equal(sawRecovery, true);
    if (scenario === 'invalid-stall') { assert.equal(result.outcome.status, 'error'); assert.match((result.outcome as { reason: string }).reason, /Recovery stalled.*script/); assert.equal(turns, 4); }
    else { assert.equal(result.outcome.status, 'rehearsed'); assert.equal(await page.locator('#institution').inputValue(), 'SHIATS'); }
    const trace = JSON.parse(readFileSync(join(directory, 'traces', `${scenario}.json`), 'utf8'));
    assert.match(trace.steps[triggerTurn].screenshot, /^data:image\/jpeg;base64,/);
    await context.close();
    console.log(`PASS: ${scenario}, fresh screenshot and normal tools retained.`);
  }
} finally { globalThis.fetch = originalFetch; await browser.close(); rmSync(directory, { recursive: true, force: true }); }
