import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'patchright';
import { browserTarget } from './browser-target.js';
import { nativeReadback, nativeInspect, nativeSnapshot, browserFailureEvidence, waitAfterAction, hasWaitCondition, evaluateBrowser } from './native-browser.js';
import { observe, renderObservation } from './observe.js';
import { ApplicationReadiness } from './application-readiness.js';

test('observations capture a usable viewport while a web font remains pending', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/pending-font.woff2', async route => { await pending; await route.abort().catch(() => {}); });
    try {
      await page.setContent(`<style>@font-face{font-family:Pending;src:url(https://fixture.invalid/pending-font.woff2)}label{font-family:Pending, sans-serif}</style><main><label>Name<input value="Saved answer"></label><button>Continue</button></main>`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.fonts.status === 'loading');
      const started = Date.now();
      const observation = await observe(page, { screenshot: true });
      assert.ok(Date.now() - started < 8_000, 'font loading does not consume the observation deadline');
      assert.ok(observation.screenshot?.startsWith('data:image/jpeg;base64,'));
      const jpeg = Buffer.from(observation.screenshot!.split(',')[1], 'base64');
      assert.ok(jpeg.length > 1000);
      assert.equal(jpeg.readUInt16BE(0), 0xffd8);
      assert.ok(observation.fields.some(field => field.currentValue === 'Saved answer'));
      assert.equal(await page.locator('#__agent_marks').count(), 0);
      assert.equal(await page.locator('input').inputValue(), 'Saved answer');
    } finally { release(); }
  } finally { await browser.close(); }
});

test('action observations distinguish accessibility-hidden proxy buttons without removing native uploads', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div style="position:relative;width:200px;height:50px"><button aria-hidden="true" style="width:100%;height:100%">Create Account</button><div role="button" aria-label="Create Account" style="position:absolute;inset:0" onclick="window.activated=true"></div></div><label>Resume<input type="file" hidden aria-hidden="true"></label>`);
    const observation = await observe(page);
    const buttons = observation.actions.filter(action => action.text === 'Create Account');
    assert.equal(buttons.length, 2);
    assert.equal(buttons.filter(action => action.ariaHidden).length, 1);
    assert.match(renderObservation(observation), /aria-hidden=true/);
    assert.ok(observation.actions.some(action => action.role === 'file'), 'hidden native file targets remain available');
    await browserTarget(page, {ref:buttons.find(action => !action.ariaHidden)!.ref}).click();
    assert.equal(await evaluateBrowser(page, {script:'window.activated'}), true);
  } finally { await browser.close(); }
});

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
    await page.locator('#name').evaluate(node => {
      node.parentElement!.insertBefore(document.createTextNode('\n    \n   '), node);
      (node as HTMLInputElement).value = 'Exact  value\n';
    });
    const compactName = await nativeReadback(page.locator('#name')) as {label: string; value: string};
    assert.equal(compactName.label, 'Name', 'markup indentation is not useful label evidence');
    assert.equal(compactName.value, await page.locator('#name').inputValue(), 'actual values are not normalized');
    await page.locator('#shadow').evaluate(node => node.attachShadow({ mode: 'open' }).innerHTML = '<label>Phone<input></label>');
    assert.equal((await nativeInspect(page.locator('#shadow')) as {shadow_root: string}).shadow_root, 'open');
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
    await page.setContent('<button>One</button><button>Two</button>');
    assert.equal(await waitAfterAction(page, { action: 'wait', selector: 'button', state: 'visible', timeout_ms: 100 }), undefined, 'a read-only existence wait allows multiple matches');
    assert.equal(hasWaitCondition({ action: 'wait', selector: 'button', timeout_ms: 100 }), true);
    assert.equal(hasWaitCondition({ action: 'wait', timeout_ms: 100 }), false);
    await page.setContent('<button hidden>Hidden first</button><button id=visible>Visible second</button>');
    assert.equal(await waitAfterAction(page, { action: 'wait', selector: 'button', state: 'visible', timeout_ms: 100 }), undefined, 'hidden first match cannot hide a visible later match');
    assert.match((await waitAfterAction(page, { action: 'wait', selector: 'button', state: 'hidden', timeout_ms: 30 }))!, /timed out/, 'absence waits until all matches are hidden');
    await page.locator('#visible').evaluate(node => (node as HTMLElement).hidden = true);
    assert.equal(await waitAfterAction(page, { action: 'wait', selector: 'button', state: 'hidden', timeout_ms: 100 }), undefined);
    assert.match((await waitAfterAction(page, { action: 'wait', selector: 'button', state: 'detached', timeout_ms: 30 }))!, /timed out/, 'hidden elements remain attached');
    await page.locator('button').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    assert.equal(await waitAfterAction(page, { action: 'wait', selector: 'button', state: 'detached', timeout_ms: 100 }), undefined);
    assert.match((await waitAfterAction(page, { action: 'click', wait: { selector: '#123-invalid-css' } }))!, /action completed.*could not be evaluated/s);
    await page.setContent('<main><label>Contact method<input role=combobox readonly aria-haspopup=listbox></label><label>Locked answer<input disabled></label></main><div role=dialog aria-modal=true><h2>Privacy notice</h2><button>Close notice</button></div>');
    const state = await observe(page);
    assert.equal(state.fields.find(field => field.label === 'Contact method')?.readOnly, true);
    assert.equal(state.fields.find(field => field.label === 'Locked answer')?.disabled, true);
    assert.match(renderObservation(state), /read-only/);
    assert.match(renderObservation(state), /VISIBLE DIALOG LAYER.*Privacy notice/s, 'modal context outside main must be shown to the agent');
    assert.equal((await nativeReadback(page.getByRole('combobox')) as { readOnly: boolean }).readOnly, true);
    await page.setContent('<label>Password<input type=password value="private-fixture"></label>');
    const privateInput = await nativeReadback(page.getByLabel('Password')) as { private: boolean };
    assert.equal(privateInput.private, true); assert.equal(JSON.stringify(privateInput).includes('private-fixture'), false);
    await page.setContent('<main><section><label>City<input id=city value=Sydney></label></section><section><label>Password<input type=password value="private-fixture"></label></section></main>');
    const multiple = await nativeInspect(page.locator('input')) as { matched: number; fields: Array<{label: string; value: string; id: string | null}> };
    assert.equal(multiple.matched, 2);
    assert.equal(multiple.fields[0].label, 'City'); assert.equal(multiple.fields[0].value, 'Sydney');
    assert.equal(multiple.fields[0].id, 'city'); assert.equal(multiple.fields[1].value, '[private credential]');
    assert.equal(JSON.stringify(multiple).includes('private-fixture'), false);
    assert.deepEqual(await nativeInspect(page.locator('#missing')), { matched: 0, visibleMatched: 0, truncated: false, fields: [] });
    await assert.rejects(nativeReadback(page.locator('input')), /strict mode violation/, 'mutation readback is still strict');
    await assert.rejects(page.locator('input').fill('wrong', { timeout: 100 }), /strict mode violation/);
    assert.equal(await page.locator('#city').inputValue(), 'Sydney', 'ambiguous writes execute nowhere');
    const snapshot = await nativeSnapshot(page.locator('section'));
    assert.match(snapshot, /Matched 2 snapshot targets/); assert.match(snapshot, /City/);
    assert.doesNotMatch(snapshot, /private-fixture/, 'accessibility snapshots do not expose password contents');
    assert.match(await nativeSnapshot(page.locator('#missing')), /No matching snapshot targets/);
    await page.locator('#city').evaluate(node => node.outerHTML = '<input id=city aria-label=City value=Melbourne>');
    assert.equal((await nativeInspect(page.locator('#city')) as {value: string}).value, 'Melbourne', 'locators describe the replacement node');
    await page.setContent(Array.from({ length: 81 }, (_, index) => `<label>Field ${index}<input></label>`).join(''));
    const bounded = await nativeInspect(page.locator('input')) as { matched: number; truncated: boolean; fields: unknown[] };
    assert.equal(bounded.matched, 81); assert.equal(bounded.truncated, true); assert.equal(bounded.fields.length, 80);
    await page.setContent(`<section><label>Password<input type=password value="TOKENstart${'PRIVATE'.repeat(1500)}TOKENend"></label></section><section>Other</section>`);
    assert.doesNotMatch(await nativeSnapshot(page.locator('section')), /TOKENstart|PRIVATE|TOKENend/, 'mask before truncating long sections');
    await page.setContent('<label>Password<input type=password value="transient-private-fixture"></label>');
    const originalSnapshot = page.ariaSnapshot.bind(page);
    page.ariaSnapshot = async options => { const text = await originalSnapshot(options); await page.setContent('<p>Redirected</p>'); return text; };
    assert.doesNotMatch(await nativeSnapshot(page), /transient-private-fixture/, 'a redirect after capture cannot erase the old secret from masking');
    page.ariaSnapshot = originalSnapshot;
    await page.setContent('<section id=education><h3>Education</h3><button>Add</button></section><section id=experience><h3>Experience</h3><button>Add</button></section><iframe id=chat title=Chatbot srcdoc="<button>Close chat</button>"></iframe><label>Password<input type=password value=private-diagnostic-fixture></label>');
    const diagnostic = await browserFailureEvidence(page, { locator: { by: 'role', value: 'button', name: 'Add' } });
    assert.match(diagnostic, /Education/); assert.match(diagnostic, /Experience/); assert.match(diagnostic, /Chatbot/);
    assert.doesNotMatch(await browserFailureEvidence(page, { selector: 'input' }), /private-diagnostic-fixture/);
    await page.setContent('<main>Contact details<iframe id=application srcdoc="<div id=shadow></div><label>Password<input type=password value=private-recovery-fixture></label>"></iframe></main>');
    const formFrame = page.frameLocator('#application');
    await formFrame.locator('#shadow').evaluate(node => {
      node.attachShadow({mode:'open'}).innerHTML = '<button aria-label="Country" aria-expanded="true">Choose country</button><div role=listbox><button role=option onclick="this.getRootNode().querySelector(\'button\').textContent=this.textContent;this.parentElement.remove()">Australia</button></div><label><input type=checkbox>Consent to contact</label>';
    });
    const failure = await browserFailureEvidence(page, { action: 'click', selector: '#wrong-target' });
    assert.match(failure, /untrusted-failure-page/);assert.match(failure, /Australia/);assert.match(failure, /Consent to contact/);
    assert.doesNotMatch(failure, /private-recovery-fixture/);
    assert.equal(await formFrame.getByRole('button', {name:'Country',exact:true}).innerText(), 'Choose country', 'diagnostics never execute a repair');
    await browserTarget(page, { locator: { by:'role', value:'option', name:'Australia', exact:true, frame:'#application' } }).click();
    assert.equal(await formFrame.getByRole('button', {name:'Country',exact:true}).innerText(), 'Australia', 'a fresh native locator reaches the actual shadow option inside an iframe');
    await page.setContent('<label for=decision>*</label><button id=decision aria-expanded=true aria-controls=choices>Choose</button><div id=choices role=listbox><div role=option>No</div></div>');
    const optionObservation = await observe(page);
    const option = optionObservation.actions.find(action => action.role === 'option');
    assert.equal(option?.value, 'No');
    assert.match(renderObservation(optionObservation), /raw_option_text="No"/);
    assert.match(renderObservation(optionObservation), /question_context="\*"/);
    await page.getByRole('option', { name: option!.value, exact: true }).click();
    await page.setContent('<div id=history aria-label="Employment history"><div id=experience aria-label="Add experience entry"></div></div><div id=education aria-label="Add education entry"></div>');
    for (const id of ['experience', 'education']) await page.locator('#'+id).evaluate(node => {
      const root=node.attachShadow({mode:'open'});root.innerHTML='<div><span><button>Add</button></span></div>';
      root.querySelector('button')!.addEventListener('click',()=>node.setAttribute('data-opened','true'));
    });
    const reveals = (await observe(page)).actions.filter(action => action.text === 'Add');
    assert.equal(reveals.length, 2);
    const experience = reveals.find(action => action.context?.includes('Add experience entry'));
    const education = reveals.find(action => action.context?.includes('Add education entry'));
    assert.ok(experience); assert.ok(education);
    assert.match(experience.context!, /Employment history/);
    assert.doesNotMatch(education.context!, /Add experience entry/);
    assert.notEqual(experience.ref, education.ref, 'separate controls retain their own observed identity');
    await page.locator(`[data-ref-id="${experience.ref}"]`).click();
    assert.equal(await page.locator('#experience').getAttribute('data-opened'), 'true');
    assert.equal(await page.locator('#education').getAttribute('data-opened'), null);
    await page.setContent('<h2>Experience</h2><div id=first></div><div id=second></div><h2>Education</h2><div id=study></div>');
    for (const [id,value] of [['first','10/2024'],['second','10/2022'],['study','']]) await page.locator('#'+id).evaluate((node,value) => {
      node.attachShadow({mode:'open'}).innerHTML=`<label>From<input placeholder="Pick a date" value="${value}"></label>`;
    },value);
    const dates = await observe(page);
    assert.deepEqual(dates.fields.map(field=>field.section),['Experience','Experience','Education']);
    assert.equal(new Set(dates.fields.map(field=>field.controlIdentity)).size,3,'equal labels and hints in repeated editors remain distinct');
    const review = new ApplicationReadiness(); review.observe(dates);
    const before = JSON.parse(review.render().split('): ')[1].split('\n')[0]);
    assert.equal(before.length,3);assert.deepEqual(before.map((v:{value:string})=>v.value),['10/2024','10/2022','']);
    review.record('ready');
    await page.locator('#first input').evaluate(node=>node.outerHTML='<input placeholder="Pick a date" value="11/2024">');
    const refreshed = await observe(page);review.observe(refreshed);
    assert.equal(refreshed.fields[0].controlIdentity,dates.fields[0].controlIdentity,'rerendered control retains its composed identity');
    assert.equal(review.request(),true);
    const after = JSON.parse(review.render().split('): ')[1].split('\n')[0]);
    assert.equal(after.length,3);assert.deepEqual(after.map((v:{value:string})=>v.value),['11/2024','10/2022','']);
    await page.setContent('<div hidden>'+Array.from({length:90},(_,i)=>`<div role=option>Hidden ${i}</div>`).join('')+'</div><section aria-label="City suggestions"><div role=option>Sydney, Australia</div></section>');
    const options = await nativeInspect(page.getByRole('option', {includeHidden:true})) as {matched:number;visibleMatched:number;truncated:boolean;fields:Array<{match_index:number;visible:boolean;text:string}>};
    assert.equal(options.matched,91);assert.equal(options.visibleMatched,1);assert.equal(options.truncated,true);
    assert.equal(options.fields[0].text,'Sydney, Australia');assert.equal(options.fields[0].visible,true);
    assert.equal(options.fields[0].match_index,90,'visible-first inspection preserves the original locator index');
    assert.equal(await page.getByRole('option',{includeHidden:true}).nth(options.fields[0].match_index).innerText(),'Sydney, Australia');
    await page.setContent('<section><button onclick="document.body.dataset.clicked=\'first\'">First target</button></section><section><button>Second target</button></section><section><button>Third target</button></section>');
    const multi = await nativeSnapshot(page.locator('section'));
    const refs = [...multi.matchAll(/button[^\n]*\[ref=([^\]]+)\]/g)].map(match=>match[1]);
    assert.equal(refs.length,3);
    for (const ref of refs) assert.equal(await browserTarget(page,{ref}).count(),1,'every returned reference is usable after the complete inspection');
    await browserTarget(page,{ref:refs[0]}).click();
    assert.equal(await page.locator('body').getAttribute('data-clicked'),'first','first returned section still targets its own control');
  } finally { await browser.close(); }
});
