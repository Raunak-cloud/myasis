import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { JobListing, CandidateProfile } from '../types.js';
import { withApplicationModel } from '../application-model.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-screenshots-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', ALLOW_EXTERNAL_APPLY: 'true',
  DRY_RUN: 'true', COST_TRACKING: 'false', FORM_CORPUS_DIR: join(directory, 'corpus') });
const { runApplicationAgent } = await import('./loop.js');
const html = `<style>body{font:18px Arial;margin:25px}label{display:block;margin:15px}button{margin:8px;padding:10px}</style>
  <main><h1>Fictional application</h1><label>Full name<input id=name></label>
  <label>Referral source<select id=source><option value="">Choose</option><option value=website>Company website</option></select></label>
  <fieldset><legend>Work rights</legend><label><input type=radio name=rights value=citizen>Australian citizen</label><label><input type=radio name=rights value=visa>Visa</label></fieldset>
  <label><input type=checkbox id=consent>Agree to processing</label>
  <button id=country aria-haspopup=listbox aria-expanded=false onclick="this.setAttribute('aria-expanded','true');document.querySelector('#options').hidden=false">Country</button>
  <div id=options role=listbox hidden><button role=option onclick="document.querySelector('#country').textContent='Australia';document.querySelector('#country').setAttribute('aria-expanded','false');document.querySelector('#options').hidden=true">Australia</button></div>
  <button id=submit onclick="window.sends=(window.sends||0)+1;document.querySelector('main').innerHTML='<h1>Application received</h1><p>Receipt SCREENSHOT-001</p>'">Submit application</button></main>`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const originalFetch = globalThis.fetch;
try {
  for (const setting of [undefined, false, true]) {
    const enabled = setting !== false;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid')
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    const page = await context.newPage();
    const url = 'https://screenshots.fixture.invalid/apply';
    await page.goto(url);
    let turn = 0;
    let initialImage = '';
    const imagesSeen: number[] = [];
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.ok(body.tools?.length, 'only the applying agent makes submission decisions');
      const latest = body.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
      const allImages = body.messages.flatMap((message: { content: unknown }) => Array.isArray(message.content)
        ? message.content.filter((part: { type: string }) => part.type === 'image_url') : []);
      imagesSeen.push(allImages.length);
      assert.equal(allImages.length, enabled ? 1 : 0, 'only the current image goes to each decision; off remains on-demand');
      if (enabled) {
        assert.ok(latest.content.some((part: { type: string }) => part.type === 'image_url'));
        assert.match(allImages[0].image_url.url, /^data:image\/jpeg;base64,/);
        if (!turn) initialImage = allImages[0].image_url.url;
        else assert.notEqual(allImages[0].image_url.url, initialImage, 'new form state produces a fresh picture');
      }
      const observation = JSON.stringify(latest.content);
      let calls;
      switch (turn++) {
        case 0:
          calls = [{ name: 'browser_batch', args: { actions: [
            { action: 'fill', locator: { by: 'label', value: 'Full name' }, value: 'Alex Fixture' },
            { action: 'select', selector: '#source', value: 'Company website' },
            { action: 'check', locator: { by: 'label', value: 'Australian citizen' }, value: 'true' },
            { action: 'check', locator: { by: 'label', value: 'Agree to processing' }, value: 'true' },
          ] } }];
          break;
        case 1:
          {
            const live = JSON.parse(readFileSync(join(directory, 'traces', `screenshot-test-${enabled}.live.json`), 'utf8'));
            assert.equal(live.steps[0].screenshot, enabled ? initialImage : undefined, 'in-progress history retains the actual decision image');
          }
          assert.match(observation, /Alex Fixture/);
          assert.match(JSON.stringify(body.messages), /Company website/);
          calls = [{ name: 'browser_action', args: { action: 'click', selector: '#country' } }];
          break;
        case 2:
          assert.match(observation, /Australia/);
          calls = [{ name: 'browser_action', args: { action: 'click', locator: { by: 'role', value: 'option', name: 'Australia' } } }];
          break;
        case 3:
          assert.match(observation, /Australia/);
          calls = [{ name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } }];
          break;
        case 4:
          assert.match(observation, /SCREENSHOT-001/);
          calls = [{ name: 'finish', args: { status: 'applied', reason: 'Fixture receipt', evidence: 'Application received', receipt: { quote: 'Application received' } } }];
          break;
        default: throw new Error('Unexpected extra decision turn');
      }
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({
        id: `turn-${turn}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
      })) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    }) as typeof fetch;
    const env = { ...process.env };
    delete env.APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN;
    if (setting !== undefined) env.APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN = String(setting);
    const result = await withApplicationModel(env,
      () => runApplicationAgent({ page, simulation: 'isolated-form',
        job: { id: `screenshot-test-${enabled}`, title: 'Fictional application', company: 'Fixture Employer', location: 'Sydney', platform: 'seek', url, source: 'chosen', applicationMode: 'external' } as JobListing,
        profile: { name: 'Alex Fixture', email: 'alex@example.invalid', phone: '0400000000', workRights: 'Citizen', workRightsCountry: 'Australia', skills: [] } as unknown as CandidateProfile,
        log: () => {} }));
    assert.equal(result.outcome.status, 'rehearsed');
    assert.equal(turn, 5);
    assert.equal(await page.evaluate('window.sends', undefined, undefined, false), 1);
    const saved = JSON.parse(readFileSync(join(directory, 'traces', `screenshot-test-${enabled}.json`), 'utf8'));
    assert.equal(saved.steps.length, 5);
    for (const step of saved.steps) {
      if (enabled) assert.match(step.screenshot, /^data:image\/jpeg;base64,/, 'every saved decision has its capture');
      else assert.equal(step.screenshot, undefined, 'opt-out history does not invent screenshots');
    }
    if (enabled) assert.notEqual(saved.steps.at(-1).screenshot, saved.steps[0].screenshot, 'receipt history uses a fresh image, not the opening page');
    console.log(JSON.stringify({ mode: setting === undefined ? 'default-on' : enabled ? 'every-turn' : 'on-demand', turns: turn, imagesPerRequest: imagesSeen, isolatedApplication: 'passed' }));
    await context.close();
  }
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
