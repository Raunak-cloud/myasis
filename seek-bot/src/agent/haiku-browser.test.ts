import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { HaikuBrowserExecutor, HAIKU_BROWSER_BATCH_HALTED, type HaikuBrowserResult, type HaikuBrowserMutation } from './haiku-browser.js';
import type { ToolContext } from './tools/context.js';
import { toolRun } from '../tool-run.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-native-browser-'));
const owner = join(directory, 'owner'); mkdirSync(owner);
const approved = join(owner, 'approved-resume.txt'), unregistered = join(owner, 'not-staged.txt'), foreign = join(directory, 'foreign.txt');
writeFileSync(approved, 'Fixture approved resume'); writeFileSync(unregistered, 'Fixture unregistered data'); writeFileSync(foreign, 'Another owner fixture');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const context = await browser.newContext({ viewport: { width: 900, height: 650 } });
const markup = `<main><h1>Fixture application</h1>
<label>Full name<input id="name" value="Original"></label>
<label>Accept declaration<input id="accept" type="checkbox"></label>
<label>Department<select id="department"><option value="one">One</option><option value="two">Two</option></select></label>
<label>Resume<input id="resume" type="file"></label>
<input id="hidden-resume" type="file" style="display:none"><button id="choose-hidden" onclick="document.querySelector('#hidden-resume').click()">Upload document</button>
<label>Password<input type="password" id="password" value="PRIVATE_PASSWORD_MUST_NOT_BE_READ"></label>
<label>Verification code<input name="otp" id="code" value="PRIVATE_CODE_MUST_NOT_BE_READ"></label>
<button id="change" onclick="document.querySelector('#name').value='Clicked'">Change name</button>
<input id="input-submit" type="submit" value="Input submit action" onclick="event.preventDefault()">
<a id="next" href="/next">Continue application</a>
<iframe title="Embedded form" srcdoc="<label>Embedded name<input id='embedded'></label><label>OTP<input name='otp' value='PRIVATE_FRAME_CODE'></label>" style="display:block;width:500px;height:90px"></iframe>
<div hidden>HIDDEN_PRIVATE_TEXT</div><div style="height:1000px"></div><button id="bottom">Bottom action</button></main>`;
await context.route('https://native.fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: markup }));
const page = await context.newPage(); await page.goto('https://native.fixture.invalid/start');
const ctx = { page } as ToolContext;
let blocked = false; const seen: HaikuBrowserMutation[] = [];
const executor = new HaikuBrowserExecutor(ctx, { ownerDataDir: owner, resolveHost: async () => ['93.184.216.34'],
  beforeMutation: async info => {
    seen.push(info);
    assert.equal(info.targetInfo?.sensitive ? info.targetInfo.currentValue : undefined, undefined, 'protected values never enter the callback');
    if (blocked) return { kind: 'terminal', outcome: { status: 'needs-human', reason: 'Fixture application guard withheld the action.' } };
  },
});
const output = (result: HaikuBrowserResult): string => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
const success = (result: HaikuBrowserResult) => assert.ok(!result.is_error, output(result));
const refFor = (result: HaikuBrowserResult, label: string): string => {
  const line = output(result).split('\n').find(line => line.includes(label) && /\[ref_\d+\]/.test(line));
  assert.ok(line, `No native ref for ${label}: ${output(result)}`); return /\[(ref_\d+)\]/.exec(line)![1];
};
try {
  const read = await executor.execute('read_page', { filter: 'all' }); success(read);
  assert.ok(!output(read).includes('PRIVATE_PASSWORD_MUST_NOT_BE_READ') && !output(read).includes('PRIVATE_CODE_MUST_NOT_BE_READ'));
  assert.ok(!output(read).includes('HIDDEN_PRIVATE_TEXT'));
  const name = refFor(read, 'Full name'), checkbox = refFor(read, 'Accept declaration'), department = refFor(read, 'Department'), upload = refFor(read, 'Resume');
  const again = await executor.execute('read_page', { filter: 'all' });
  assert.equal(refFor(again, 'Full name'), name, 'fresh observations never renumber an existing DOM node');
  await page.evaluate(() => { document.querySelector('main')!.prepend(document.createElement('button')); });
  assert.equal(refFor(await executor.execute('read_page', { filter: 'all' }), 'Full name'), name, 'unrelated DOM insertion keeps an existing native ref stable');
  success(await executor.execute('form_input', { target: { type: 'ref', ref: name }, value: 'Correct candidate' }));
  assert.equal(await page.locator('#name').inputValue(), 'Correct candidate');
  success(await executor.execute('form_input', { target: { type: 'ref', ref: checkbox }, value: true }));
  assert.equal(await page.locator('#accept').isChecked(), true);
  success(await executor.execute('form_input', { target: { type: 'ref', ref: department }, value: 'Two' }));
  assert.equal(await page.locator('#department').inputValue(), 'two', 'native selects accept visible text as documented');
  success(await executor.execute('left_click', { target: { type: 'ref', ref: name } }));
  success(await executor.execute('key', { text: 'ctrl+a' }));
  success(await executor.execute('type', { text: 'Typed candidate' }));
  assert.equal(await page.locator('#name').inputValue(), 'Typed candidate');
  assert.ok(seen.some(info => info.name === 'type' && info.locator && info.targetInfo?.label === 'Full name'), 'focused writes expose the actual target to grounding');
  const submitTree = await executor.execute('read_page', { filter: 'interactive' }); success(submitTree);
  success(await executor.execute('left_click', { target: { type: 'ref', ref: refFor(submitTree, 'Input submit action') } }));
  assert.equal(seen.at(-1)?.targetInfo?.editable, false, 'input-submit is an action and must reach advance/submit checks');
  assert.ok(seen.some(info => info.name === 'type' && info.targetInfo?.editable === true), 'text controls remain editable');

  const box = await page.locator('#name').boundingBox(); assert.ok(box);
  success(await executor.execute('left_click', { target: { type: 'coordinate', x: Math.round(box.x + 8), y: Math.round(box.y + 8) } }));
  success(await executor.execute('form_input', { target: { type: 'ref', ref: name }, value: 'Reference survived coordinate click' }));
  assert.equal(await page.locator('#name').inputValue(), 'Reference survived coordinate click');
  const found = await executor.execute('find', { query: 'change name button' }); success(found); assert.ok(output(found).includes('Change name'));
  const screenshot = await executor.execute('screenshot', {}); success(screenshot);
  assert.ok(screenshot.content.some(block => block.type === 'image'));
  assert.equal(await page.locator('#code').getAttribute('data-haiku-protected-field'), 'true', 'OTP/name/label fields are masked without relying on autocomplete');
  assert.equal(await page.frameLocator('iframe').locator('[name="otp"]').getAttribute('data-haiku-protected-field'), 'true', 'child-frame credentials are masked too');
  const zoom = await executor.execute('zoom', { region: [0, 0, 300, 200] }); success(zoom);
  const image = zoom.content.find(block => block.type === 'image'); assert.ok(image && image.type === 'image');
  assert.equal(Buffer.from(image.source.data, 'base64').readUInt32BE(16), 600);
  assert.equal(Buffer.from(image.source.data, 'base64').readUInt32BE(20), 400);

  blocked = true;
  const withheld = await executor.execute('form_input', { target: { type: 'ref', ref: name }, value: 'MUST NOT LAND' });
  assert.equal(withheld.is_error, true); assert.equal(withheld.terminal?.status, 'needs-human');
  assert.equal(await page.locator('#name').inputValue(), 'Reference survived coordinate click');
  assert.ok(!withheld.content.some(block => block.type === 'browser_state'), 'error results never carry browser_state');
  blocked = false;
  const password = refFor(await executor.execute('read_page', { filter: 'all' }), 'Password');
  assert.equal((await executor.execute('form_input', { target: { type: 'ref', ref: password }, value: 'new secret' })).is_error, true);
  await page.locator('#password').focus();
  assert.equal((await executor.execute('type', { text: 'new secret' })).is_error, true);
  assert.equal((await executor.execute('key', { text: 'ctrl+a Backspace' })).is_error, true);
  assert.equal((await executor.execute('hold_key', { text: 'Backspace', duration: 0 })).is_error, true);
  assert.equal(await page.locator('#password').inputValue(), 'PRIVATE_PASSWORD_MUST_NOT_BE_READ');
  await page.locator('#password').evaluate(el => { const before = document.createElement('input'); before.id = 'before-secret'; before.setAttribute('aria-label', 'Public field before secret'); el.before(before); before.focus(); });
  assert.equal((await executor.execute('key', { text: 'Tab Backspace' })).is_error, true, 'each chord rechecks newly focused fields');
  assert.equal(await page.locator('#password').inputValue(), 'PRIVATE_PASSWORD_MUST_NOT_BE_READ');
  const embedded = page.frameLocator('iframe').locator('#embedded');
  await embedded.scrollIntoViewIfNeeded(); const embeddedBox = await embedded.boundingBox(); assert.ok(embeddedBox);
  success(await executor.execute('left_click', { target: { type: 'coordinate', x: Math.round(embeddedBox.x + 5), y: Math.round(embeddedBox.y + 5) } }));
  assert.equal(seen.at(-1)?.targetInfo?.label, 'Embedded name', 'coordinate guards resolve the actual child-frame control');
  success(await executor.execute('type', { text: 'Child frame candidate' }));
  assert.equal(await embedded.inputValue(), 'Child frame candidate');
  assert.equal((await executor.execute('key', { text: 'Tab Backspace' })).is_error, true, 'nested focus also blocks credential editing');
  assert.equal(await page.frameLocator('iframe').locator('[name="otp"]').inputValue(), 'PRIVATE_FRAME_CODE');
  success(await executor.execute('hover', { target: { type: 'ref', ref: name }, modifiers: 'shift' }));

  assert.throws(() => executor.registerDocument('foreign', foreign), /inside this account directory/);
  assert.equal((await executor.execute('file_upload', { target: { type: 'ref', ref: upload }, paths: [unregistered] })).is_error, true, 'owner containment alone is not an upload grant');
  executor.registerDocument('approved-resume', approved);
  success(await executor.execute('file_upload', { target: { type: 'ref', ref: upload }, document_ids: ['approved-resume'] }));
  assert.equal(await page.locator('#resume').evaluate(el => (el as HTMLInputElement).files?.[0]?.name), 'approved-resume.txt');
  const chooserRead = await executor.execute('read_page', { filter: 'all' }); success(chooserRead);
  assert.equal(await page.locator('#hidden-resume').getAttribute('data-haiku-protected-field'), null);
  const chooser = await executor.execute('left_click', { target: { type: 'ref', ref: refFor(chooserRead, 'Upload document') } }); success(chooser);
  const hiddenRef = /actual file input \[(ref_\d+)\]/.exec(output(chooser))?.[1]; assert.ok(hiddenRef, `a real native chooser exposes its otherwise inaccessible input: ${output(chooser)}`);
  success(await executor.execute('file_upload', { target: { type: 'ref', ref: hiddenRef }, document_ids: ['approved-resume'] }));
  assert.equal(await page.locator('#hidden-resume').evaluate(el => (el as HTMLInputElement).files?.[0]?.name), 'approved-resume.txt');
  try { const link = join(owner, 'escaped-link.txt'); symlinkSync(foreign, link, 'file'); assert.throws(() => executor.registerDocument('symlink', link), /inside this account directory/); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }

  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1', 'http://10.1.2.3', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://169.254.169.254', 'http://localhost', 'https://user:pass@native.fixture.invalid']) {
    assert.equal((await executor.execute('navigate', { url })).is_error, true, `refuse unsafe destination ${url}`);
  }
  success(await executor.execute('navigate', { url: 'native.fixture.invalid/next' }));
  assert.equal((await executor.execute('form_input', { target: { type: 'ref', ref: name }, value: 'stale' })).is_error, true, 'navigation expires old refs');
  const freshName = refFor(await executor.execute('read_page', { filter: 'all' }), 'Full name');
  assert.notEqual(freshName, name, 'native refs are never reused for another page');
  const batch = await executor.executeBatch([
    { id: 'first', toolset_name: 'browser', name: 'left_click', input: { target: { type: 'ref', ref: name } } },
    { id: 'second', toolset_name: 'browser', name: 'form_input', input: { target: { type: 'ref', ref: freshName }, value: 'MUST NOT RUN' } },
  ]);
  assert.equal(batch.length, 2); assert.equal(batch[0].is_error, true); assert.equal(output(batch[1]), HAIKU_BROWSER_BATCH_HALTED);
  assert.equal(await page.locator('#name').inputValue(), 'Original');
  assert.equal((await executor.execute('javascript_exec', { text: 'document.cookie' })).is_error, true);
  assert.equal((await executor.execute('left_click', { target: { type: 'coordinate', x: -1, y: 0 } })).is_error, true);
  assert.equal((await executor.execute('key', { text: 'Enter', repeat: 101 })).is_error, true);
  const retired = await toolRun.run({ generation: 1, retired: true }, () => executor.execute('form_input', { target: { type: 'ref', ref: freshName }, value: 'LATE WRITE' }));
  assert.equal(retired.is_error, true); assert.equal(await page.locator('#name').inputValue(), 'Original');

  const opened = await executor.execute('new_tab', {}); success(opened); assert.equal(opened.content.length, 1);
  const inventory = opened.content[0]; assert.equal(inventory.type, 'browser_state');
  if (inventory.type !== 'browser_state') throw new Error('Missing state');
  assert.equal(inventory.tabs.filter(tab => tab.active).length, 1);
  assert.equal(inventory.state_changes?.filter(change => change.type === 'tab_opened').length, 1);
  const originalTab = inventory.tabs.find(tab => tab.url.includes('/next'))!.tab_id;
  const openedTab = inventory.tabs.find(tab => tab.active)!.tab_id;
  success(await executor.execute('switch_tab', { tab_id: originalTab })); assert.equal(ctx.page, page);
  success(await executor.execute('close_tab', { tab_id: openedTab }));
  const listed = await executor.execute('list_tabs', {}); success(listed); assert.equal(listed.content.length, 1);
  console.log('PASS: native refs/coordinates/forms/keys/screenshots/zoom/tabs, mandatory mutation guard, secret exclusion, owner-staged uploads, stale refs, batch halt, retired tools and public URL policy. Offline browser fixtures; no model calls.');
} finally {
  await executor.dispose(); await browser.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-native-browser-'));
  rmSync(directory, { recursive: true, force: true });
}
