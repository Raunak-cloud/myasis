import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'patchright';
import { browserTarget } from './browser-target.js';
import { nativeReadback, waitAfterAction, hasWaitCondition, evaluateBrowser } from './native-browser.js';

test('native locators retain events across rerenders, scope frames/editors/shadow DOM, and inspect values together', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent(`<main><label>Name<input id=name oninput="window.saved=this.value;let copy=this.cloneNode(true);copy.value=this.value;this.replaceWith(copy)"></label>
      <label>Salary per hour<input type=number min=20 max=80 step=.01 value=27.50 aria-describedby=help></label><p id=help>AUD per hour</p>
      <button>Copy and paste</button><section id=letter><button>Copy and paste</button></section>
      <iframe id=editor srcdoc="<body contenteditable='true' aria-label='Letter'></body>"></iframe>
      <div id=shadow></div><button id=delayed onclick="setTimeout(()=>{document.querySelector('#ready').hidden=false},100)">Continue</button><p id=ready hidden>Ready</p></main>`);
    const name = { locator: { by: 'label', value: 'Name' } };
    await browserTarget(page, name).fill('First');
    await browserTarget(page, name).fill('Second');
    assert.equal(await page.evaluate('window.saved', undefined, undefined, false), 'Second');
    assert.equal(await evaluateBrowser(page, { script: 'window.saved' }), 'Second', 'browser scripts inspect the employer page world rather than an empty isolated global');
    assert.equal((await nativeReadback(browserTarget(page, name)) as { value: string }).value, 'Second');
    await assert.rejects(browserTarget(page, { selector: 'button' }).click({ timeout: 500 }), /strict mode violation/);
    await browserTarget(page, { locator: { by: 'role', value: 'button', name: 'Copy and paste', within: '#letter' } }).click();
    const editor = { locator: { by: 'label', value: 'Letter', frame: '#editor' } };
    await browserTarget(page, editor).fill('Dear team,\n\nMy own letter.');
    assert.match(JSON.stringify(await nativeReadback(browserTarget(page, editor))), /My own letter/);
    assert.match(String(await evaluateBrowser(page, { ...editor, script: 'document.body.innerText' })), /Dear team,\n{2,}My own letter\./);
    assert.equal(await evaluateBrowser(page, { script: '1 + 2' }), 3);
    assert.equal(await evaluateBrowser(page, { script: '() => document.title' }), '');
    assert.equal(await evaluateBrowser(page, { script: 'return await Promise.resolve(4)' }), 4);
    assert.equal(await evaluateBrowser(page, { script: 'typeof process' }), 'undefined', 'scripts cannot access host Node globals');
    const salary = await nativeReadback(browserTarget(page, { locator: { by: 'label', value: 'Salary per hour' } }));
    assert.match(JSON.stringify(salary), /AUD per hour/); assert.match(JSON.stringify(salary), /"step":".01"/);
    await page.locator('#shadow').evaluate(node => node.attachShadow({ mode: 'open' }).innerHTML = '<label>Phone<input></label>');
    await browserTarget(page, { locator: { by: 'label', value: 'Phone' } }).fill('0400000000');
    await page.locator('#delayed').click();
    await waitAfterAction(page, { wait: { timeout_ms: 5000 } });
    assert.equal(hasWaitCondition({ wait: { timeout_ms: 5000 } }), false);
    assert.equal(hasWaitCondition({ wait: { selector: '#ready' } }), true);
    await waitAfterAction(page, { wait: { selector: '#ready', state: 'visible', timeout_ms: 1000 } });
    assert.equal(await page.locator('#ready').isVisible(), true);
    await page.setContent('<button onclick="window.clicks=(window.clicks||0)+1">Continue</button>');
    await page.getByRole('button', { name: 'Continue' }).click();
    assert.match((await waitAfterAction(page, { action: 'click', wait: { selector: '#never-arrives', timeout_ms: 20 } }))!, /action completed.*wait timed out/);
    assert.equal(await page.evaluate('window.clicks', undefined, undefined, false), 1, 'a timed-out follow-up wait preserves the already completed action');
    await page.setContent('<label>Password<input type=password value="private-fixture"></label>');
    const privateInput = await nativeReadback(page.getByLabel('Password')) as { private: boolean };
    assert.equal(privateInput.private, true); assert.equal(JSON.stringify(privateInput).includes('private-fixture'), false);
  } finally { await browser.close(); }
});
