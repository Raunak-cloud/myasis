import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'patchright';
import { observe, renderObservation } from './observe.js';
import { browserTarget,BrowserTargetInputError } from './browser-target.js';
import { evaluateBrowser, nativeInspect, nativeScroll } from './native-browser.js';
import { ProgressBudget } from './progress-budget.js';
import { expectationOf } from '../form-corpus.js';

test('HTML and SVG-backed controls keep stable identities when a DOM id property is not a string', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><form id="application"><label>Name<input id="name"></label><label>Alias<input name="id" value="named property"></label></form><svg id="diagram"><foreignObject width="300" height="60"><div xmlns="http://www.w3.org/1999/xhtml"><label>SVG-contained answer<input id="svg-answer"/></label></div></foreignObject></svg></main>');
    assert.equal(await page.locator('#application').evaluate(node => typeof node.id), 'object', 'the input named id shadows form.id with a DOM node');
    const before = await observe(page);
    const names = before.fields.filter(field => ['Name', 'SVG-contained answer'].includes(field.label));
    assert.equal(names.length, 2);
    assert.equal(new Set(names.map(field => field.controlIdentity)).size, 2);
    await page.locator('#name').fill('Alex Fixture');
    const after = await observe(page);
    for (const field of names) assert.equal(after.fields.find(current => current.label === field.label)?.controlIdentity, field.controlIdentity);
    assert.equal(after.fields.find(field => field.label === 'Name')?.currentValue, 'Alex Fixture');
  } finally { await browser.close(); }
});

test('cross-origin and nested form fields, actions and progress are visible without parent-document scripts', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const host = new URL(route.request().url()).hostname;
      const body = host === 'employer.invalid' ? '<main>Vacancy</main><iframe id=form src="https://forms.invalid/apply"></iframe><iframe hidden src="https://hidden.invalid/apply"></iframe>'
        : host === 'forms.invalid' ? '<form><label>Legal name<input id=name required></label><label>Password<input type=password value=frame-private-fixture></label><button>Continue</button><iframe src="https://nested.invalid/step"></iframe></form>'
          : host === 'nested.invalid' ? '<label>Legal name<input id=name required></label><button>Continue</button>'
            : '<label>Hidden frame fact<input></label>';
      return host.endsWith('.invalid') ? route.fulfill({ contentType: 'text/html', body }) : route.abort();
    });
    const page = await context.newPage(); await page.goto('https://employer.invalid/job');
    const before = await observe(page);
    assert.equal(before.frames?.length, 2, 'hidden child is excluded');
    const names = before.fields.filter(field => field.label === 'Legal name');
    assert.equal(names.length, 2);
    assert.notEqual(names[0].ref, names[1].ref, 'equal local DOM ids in separate contexts cannot collide');
    assert.equal(before.fields.some(field => field.label === 'Hidden frame fact'), false);
    assert.match(renderObservation(before), /EMBEDDED FRAMES/);
    assert.equal(expectationOf(before, false, page.url()).fields.length, 0, 'main-document corpus does not claim it serialized cross-origin fields');
    const frameRef = names[0].ref.split(':')[0];
    assert.equal(await evaluateBrowser(page, { locator: {frame: frameRef}, script: 'document.querySelector("#name").value' }), '');
    await page.evaluate(() => { document.body.style.paddingTop='2000px'; window.scrollTo(0,0); });
    await nativeScroll(page, {ref: names[0].ref});
    const box = await browserTarget(page, {ref:names[0].ref}).boundingBox();
    assert.ok(box && box.y >= 0 && box.y < 720, 'one targeted native scroll reveals a child-frame control through its parent');
    const meter = new ProgressBudget(.20); meter.observe(before.fields, false); meter.recordProvider({prompt: 0, cached: 0, completion: 0, amountUsd: .15});
    await browserTarget(page, {ref: names[0].ref}).fill('Alex Fixture');
    const after = await observe(page);
    assert.equal(after.fields.find(field => field.ref === names[0].ref)?.currentValue, 'Alex Fixture');
    assert.equal(after.fields.find(field => field.ref === names[1].ref)?.currentValue, '');
    meter.observe(after.fields, true); assert.equal(meter.progressCount, 1); assert.equal(meter.limitUsd, .25);
    await browserTarget(page, {locator: {frame: names[1].ref.split(':')[0], by: 'label', value: 'Legal name'}}).fill('Nested Fixture');
    const password = before.fields.find(field => field.inputType === 'password');
    if (password) assert.doesNotMatch(JSON.stringify(await nativeInspect(browserTarget(page, {ref: password.ref}))), /frame-private-fixture/);
    const detached = page.waitForEvent('framedetached'); await page.locator('#form').evaluate(node => node.remove()); await detached;
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id='form'; frame.src='https://forms.invalid/apply'; document.body.appendChild(frame); });
    await page.frameLocator('#form').getByLabel('Legal name', {exact: true}).waitFor();
    const replacement = await observe(page);
    assert.throws(() => browserTarget(page, {ref: names[0].ref}), error=>error instanceof BrowserTargetInputError&&/no longer attached/.test(error.message), 'an old frame reference cannot target the replacement or masquerade as a code execution failure');
    const replacementName = replacement.fields.find(field => field.label === 'Legal name')!;
    assert.notEqual(replacementName.ref, names[0].ref);
    assert.equal(await browserTarget(page, {ref: replacementName.ref}).inputValue(), '');
  } finally { await browser.close(); }
});

test('a detached frame retries the observation without exposing private authentication fields', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><label>Name<input value="Fixture"></label><iframe srcdoc="<label>Password<input type=password value=private-fixture-secret></label>"></iframe></main>');
    await page.frameLocator('iframe').getByLabel('Password').waitFor();
    const frame = page.frames().find(item => item !== page.mainFrame())!;
    const original = frame.evaluate.bind(frame) as (...args: unknown[]) => Promise<unknown>;
    let failures = 0;
    Object.defineProperty(frame, 'evaluate', { configurable: true, value: async (...args: unknown[]) => {
      if (!failures && typeof args[0] === 'function' && args[0].name === 'scanPrivateAuthenticationFields') {
        failures++; throw new Error('frame.evaluate: Frame was detached');
      }
      return original(...args);
    } });
    const result = await observe(page);
    assert.equal(failures, 1, 'the frame changed during the private-field inspection');
    assert.equal(result.fields.some(field => field.label === 'Name'), true);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-secret/, 'retry never bypasses credential redaction');
  } finally { await browser.close(); }
});
