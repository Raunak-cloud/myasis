import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
import type { ToolContext } from './tools/context.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-field-batch-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only' });
const { fillObservedFields, MAX_FIELD_BATCH } = await import('./field-batch.js');
const { observe, renderObservation } = await import('./observe.js');
const { agentOnlyTools } = await import('./agent-only.js');
const { validToolInput } = await import('./tool-input.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
let checks = 0;
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main>Offline batch fixture</main>' }));
  const setup = async (html: string) => {
    await page.setContent(`<main>${html}</main>`);
    return { page, observation: await observe(page), captured: [], actions: [] } as unknown as ToolContext;
  };
  const batch = (ctx: ToolContext, values: string[]) => fillObservedFields(ctx, values.map((value, i) => ({ ref: ctx.observation.fields[i].ref, value })));
  const disposition = (result: Awaited<ReturnType<typeof fillObservedFields>>) => result.kind === 'ok' ? result.disposition : 'terminal';
  const check = async (name: string, run: () => Promise<void>) => { await run(); checks++; console.log(`PASS ${name}`); };

  await check('native fields retain values, newlines and input/change/blur events', async () => {
    const ctx = await setup(`<label>Name<input id=name></label><label>Letter<textarea id=letter></textarea></label><label>Country<select><option value=au>Australia</option></select></label><label>Available<input type=checkbox></label>
      <script>window.events=[];for(const kind of ['input','change','blur'])document.addEventListener(kind,e=>window.events.push(e.type),true)</script>`);
    const result = await batch(ctx, ['Fixture Candidate', 'Dear team,\n\nMy letter.', 'Australia', 'true']);
    assert.equal(disposition(result), 'completed');
    assert.equal(await page.inputValue('#letter'), 'Dear team,\n\nMy letter.');
    assert.equal(await page.locator('input[type=checkbox]').isChecked(), true);
    for (const type of ['input', 'change', 'blur']) assert.ok((await page.evaluate('window.events', undefined, undefined, false) as string[]).includes(type));
    assert.equal(ctx.coverLetter, undefined);
    assert.equal(ctx.captured.length, 4);
  });
  await check('cover letter batches normalize em dashes in the actual field and recorded answer', async () => {
    const ctx = await setup('<label>Cover letter<textarea id=letter></textarea></label>');
    assert.equal(disposition(await batch(ctx, ['Dear team,\n\nFull-stack work — including APIs.'])), 'completed');
    const expected = 'Dear team,\n\nFull-stack work, including APIs.';
    assert.equal(await page.inputValue('#letter'), expected);
    assert.equal(ctx.coverLetter, expected);
    assert.equal(ctx.captured[0].answer, expected);
  });
  await check('unchanged input replacement stops before targeting the replacement', async () => {
    const ctx = await setup(`<label>First<input onblur="const old=document.querySelector('#second');old.replaceWith(old.cloneNode())"></label><label>Second<input id=second></label>`);
    assert.equal(disposition(await batch(ctx, ['First value', 'Must stay empty'])), 'reobserve');
    assert.equal(await page.inputValue('#second'), '');
    assert.equal(ctx.captured.length, 1);
  });
  await check('question wording changes with the same field count retire the rest', async () => {
    const ctx = await setup(`<label>First<input onblur="document.querySelector('#label').firstChild.textContent='Different question'"></label><label id=label>Second<input id=second></label>`);
    assert.equal(disposition(await batch(ctx, ['First value', 'Must stay empty'])), 'reobserve');
    assert.equal(await page.inputValue('#second'), '');
  });
  await check('description changes retire the rest even when markup identity is stable', async () => {
    const ctx = await setup(`<label>First<input onblur="document.querySelector('#help').textContent='Different instructions'"></label><label>Second<input id=second aria-describedby=help></label><p id=help>Original instructions</p>`);
    assert.equal(disposition(await batch(ctx, ['First value', 'Must stay empty'])), 'reobserve');
    assert.equal(await page.inputValue('#second'), '');
  });
  await check('conditional questions and deferred render updates require a fresh observation', async () => {
    const ctx = await setup(`<label>First<input onblur="requestAnimationFrame(()=>document.querySelector('main').insertAdjacentHTML('beforeend','<label>New question<input></label>'))"></label><label>Second<input id=second></label>`);
    assert.equal(disposition(await batch(ctx, ['First value', 'Must stay empty'])), 'reobserve');
    assert.equal(await page.inputValue('#second'), '');
  });
  await check('a field disabled by an earlier answer stays untouched', async () => {
    const ctx = await setup(`<label>First<input onblur="document.querySelector('#second').disabled=true"></label><label>Second<input id=second></label>`);
    assert.equal(disposition(await batch(ctx, ['First value', 'Must stay empty'])), 'reobserve');
    assert.equal(await page.inputValue('#second'), '');
  });
  await check('a change after the final field still requires re-observation', async () => {
    const ctx = await setup(`<label>Only field<input onblur="document.querySelector('main').insertAdjacentHTML('beforeend','<label>New question<input></label>')"></label>`);
    assert.equal(disposition(await batch(ctx, ['First value'])), 'reobserve');
  });
  await check('transformed and invalid values are reported and stop later writes', async () => {
    for (const attributes of [`oninput="this.value='Different value'"`, `onblur="this.setAttribute('aria-invalid','true')"`, `type=email`]) {
      const ctx = await setup(`<label>First<input ${attributes}></label><label>Second<input id=second></label>`);
      const result = await batch(ctx, ['Original value', 'Must stay empty']);
      assert.equal(disposition(result), 'reobserve');
      assert.equal(await page.inputValue('#second'), '');
    }
  });
  await check('unsupported controls and invalid later choices are rejected before any write', async () => {
    for (const second of [`<input role=combobox>`, `<input type=password>`, `<input readonly>`, `<select><option disabled>Choice</option></select>`, `<select><option value=a>Choice</option><option value=b>Choice</option></select>`]) {
      const ctx = await setup(`<label>First<input id=first></label><label>Second${second}</label>`);
      await batch(ctx, ['Must stay empty', 'Choice']);
      assert.equal(await page.inputValue('#first'), '');
    }
  });
  await check('autocomplete metadata and exact batch errors guide individual interaction', async () => {
    for (const attributes of ['role=combobox', 'aria-autocomplete=list', 'list=cities']) {
      const ctx = await setup(`<label>First name<input id=first></label><label>City<input ${attributes} aria-describedby=city-help placeholder="Start typing a city"></label><p id=city-help>Choose a city from the suggestions.</p><datalist id=cities><option>Sydney</option></datalist>`);
      const city = ctx.observation.fields[1];
      assert.equal(city.autocomplete, true);
      assert.match(renderObservation(ctx.observation), /autocomplete: type then choose an observed suggestion/);
      assert.match(renderObservation(ctx.observation), /Choose a city from the suggestions/);
      assert.match(renderObservation(ctx.observation), /placeholder=Start typing a city/);
      const result = await batch(ctx, ['Fixture', 'Sydney']);
      assert.equal(disposition(result), 'failed');
      assert.ok(result.kind === 'ok');
      assert.match(result.message, new RegExp(city.ref));
      assert.match(result.message, /City.*autocomplete/);
      assert.equal(await page.inputValue('#first'), '');
      assert.equal(disposition(await fillObservedFields(ctx, [{ ref: ctx.observation.fields[0].ref, value: 'Fixture' }])), 'completed');
    }
  });
  await check('phone punctuation does not abort a valid stable section or invent a saved value', async () => {
    const ctx = await setup(`<label>Phone<input type=tel onblur="this.value=this.value.replace(/ /g,'')"></label><label>Name<input id=name></label>`);
    assert.equal(disposition(await batch(ctx, ['+61 412 345 678', 'Fixture'])), 'completed');
    assert.equal(await page.inputValue('#name'), 'Fixture');
    assert.equal(ctx.captured[0].answer, '+61412345678');
    const changed = await setup(`<label>Phone<input type=tel onblur="this.value='+61499999999'"></label><label>Name<input id=name></label>`);
    assert.equal(disposition(await batch(changed, ['+61 412 345 678', 'Must stay empty'])), 'reobserve');
    assert.equal(await page.inputValue('#name'), '');
  });
  await check('missing/duplicate refs, oversized and malformed requests cannot start a batch', async () => {
    const ctx = await setup('<label>First<input id=first></label>');
    const ref = ctx.observation.fields[0].ref;
    for (const writes of [[], [{ ref: 'f999', value: 'No' }], [{ ref, value: 'One' }, { ref, value: 'Two' }], Array(MAX_FIELD_BATCH + 1).fill({ ref, value: 'No' })]) {
      assert.notEqual(disposition(await fillObservedFields(ctx, writes)), 'completed');
    }
    const schema = agentOnlyTools.find(tool => tool.name === 'fill_fields')!.parameters;
    for (const value of [{ fields: [] }, { fields: [{ ref }] }, { fields: [{ ref, value: true }] }, { fields: [{ ref, value: 'Yes', action: 'click' }] }, { fields: Array(MAX_FIELD_BATCH + 1).fill({ ref, value: 'No' }) }]) assert.equal(validToolInput(value, schema), false);
    assert.equal(await page.inputValue('#first'), '');
  });
  await check('a stale initial observation performs no writes', async () => {
    const ctx = await setup('<label id=label>Old question<input id=first></label>');
    await page.locator('#label').evaluate(el => { el.firstChild!.textContent = 'New question'; });
    assert.equal(disposition(await batch(ctx, ['No'])), 'reobserve');
    assert.equal(await page.inputValue('#first'), '');
  });
  await check('native select uses the chosen option index when option values repeat', async () => {
    const ctx = await setup('<label>Choice<select><option value=shared>First choice</option><option value=shared>Second choice</option></select></label>');
    assert.equal(disposition(await batch(ctx, ['Second choice'])), 'completed');
    assert.equal(await page.locator('select').evaluate(el => (el as HTMLSelectElement).selectedIndex), 1);
  });
  await check('a navigation to an identical form cannot receive remaining answers', async () => {
    const html = '<main><label>First<input id=first></label><label>Second<input id=second></label></main>';
    await page.route('https://navigation.fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://navigation.fixture.invalid/first');
    const ctx = { page, observation: await observe(page), captured: [], actions: [] } as unknown as ToolContext;
    await page.locator('#first').evaluate(el => el.addEventListener('blur', () => { location.href = '/second'; }));
    assert.notEqual(disposition(await batch(ctx, ['First', 'Must stay empty'])), 'completed');
    await page.waitForURL('**/second');
    assert.equal(await page.inputValue('#second'), '');
  });
  await check('open shadow roots retain normal browser events and readback', async () => {
    const ctx = await setup(`<div id=host></div><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<label>Shadow name<input id=name></label><label>Shadow email<input id=email type=email></label>'</script>`);
    assert.equal(disposition(await batch(ctx, ['Fixture', 'fixture@example.invalid'])), 'completed');
    assert.equal(await page.locator('#host #email').inputValue(), 'fixture@example.invalid');
  });
  await check('a wide stable section fills all 16 fields in one batch', async () => {
    const ctx = await setup(Array.from({ length: MAX_FIELD_BATCH }, (_, i) => `<label>Field ${i}<input></label>`).join(''));
    const values = Array.from({ length: MAX_FIELD_BATCH }, (_, i) => `Fixture value ${i}`);
    const started = performance.now();
    assert.equal(disposition(await batch(ctx, values)), 'completed');
    assert.deepEqual(await page.locator('input').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)), values);
    console.log(JSON.stringify({ fields: values.length, batchMs: Math.round(performance.now() - started) }));
  });
  console.log(JSON.stringify({ ok: true, checks, scope: 'Offline browser fixtures; no model or employer contacted' }));
} finally {
  await browser.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-field-batch-'));
  rmSync(directory, { recursive: true, force: true });
}
