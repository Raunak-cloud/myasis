import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'patchright';
import { observe, renderObservation } from './observe.js';
import { browserTarget } from './browser-target.js';
import { evaluateBrowser, nativeInspect } from './native-browser.js';
import { RecoveryCheckpoint } from './recovery-checkpoint.js';
import { ProgressBudget } from './progress-budget.js';
import { expectationOf } from '../form-corpus.js';

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
    const meter = new ProgressBudget(.20); meter.observe(before.fields, false); meter.recordProvider({prompt: 0, cached: 0, completion: 0, amountUsd: .15});
    const recovery = new RecoveryCheckpoint(); recovery.observe(before);
    await browserTarget(page, {ref: names[0].ref}).fill('Alex Fixture');
    const after = await observe(page);
    assert.equal(after.fields.find(field => field.ref === names[0].ref)?.currentValue, 'Alex Fixture');
    assert.equal(after.fields.find(field => field.ref === names[1].ref)?.currentValue, '');
    meter.observe(after.fields, true); assert.equal(meter.progressCount, 1); assert.equal(meter.limitUsd, .25);
    recovery.acted('browser_action', false, {action: 'fill', ref: names[0].ref}); recovery.observe(after);
    assert.equal(recovery.tool, undefined, 'real child-frame progress is not an unchanged parent page');
    await browserTarget(page, {locator: {frame: names[1].ref.split(':')[0], by: 'label', value: 'Legal name'}}).fill('Nested Fixture');
    const password = before.fields.find(field => field.inputType === 'password');
    if (password) assert.doesNotMatch(JSON.stringify(await nativeInspect(browserTarget(page, {ref: password.ref}))), /frame-private-fixture/);
    const detached = page.waitForEvent('framedetached'); await page.locator('#form').evaluate(node => node.remove()); await detached;
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id='form'; frame.src='https://forms.invalid/apply'; document.body.appendChild(frame); });
    await page.frameLocator('#form').getByLabel('Legal name', {exact: true}).waitFor();
    const replacement = await observe(page);
    assert.throws(() => browserTarget(page, {ref: names[0].ref}), /no longer attached/, 'an old frame reference cannot target the replacement');
    const replacementName = replacement.fields.find(field => field.label === 'Legal name')!;
    assert.notEqual(replacementName.ref, names[0].ref);
    assert.equal(await browserTarget(page, {ref: replacementName.ref}).inputValue(), '');
  } finally { await browser.close(); }
});
