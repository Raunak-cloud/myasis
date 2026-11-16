import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'patchright';
import { dropdownFeedback } from './dropdown-feedback.js';
import { nativeSelect } from './native-browser.js';

test('autocomplete feedback waits and selects only exact scoped choices', async t => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage();
    const fixture = (options: string, delay = 0) => `<label>Institution<input id="institution" role="combobox" aria-controls="choices" aria-expanded="false" aria-invalid="true" oninput="window.inputs=(window.inputs||0)+1;this.setAttribute('aria-expanded','true');const menu=this.getRootNode().getElementById('choices');setTimeout(()=>{menu.hidden=false},${delay})"></label><div id="choices" role="listbox" hidden>${options}</div><script>window.picks=0;document.getElementById('choices').onclick=e=>{const o=e.target.closest('[role=option]');if(!o)return;const i=document.getElementById('institution');window.picks++;i.value=o.textContent;i.setAttribute('aria-invalid','false');i.setAttribute('aria-expanded','false');document.getElementById('choices').hidden=true}</script>`;
    const option = '<div role="option">SHIATS</div>';
    await t.test('delayed SHIATS option is selected once and verified', async () => {
      await page.setContent(fixture(option, 150));
      const field = page.getByRole('combobox');
      await field.fill('shiats');
      const feedback = await dropdownFeedback(field, 'shiats', 800);
      assert.equal(feedback?.selected, true);
      assert.equal(feedback?.status, 'selected');
      assert.equal(await page.evaluate('window.picks', undefined, undefined, false), 1);
      assert.equal(await field.inputValue(), 'SHIATS');
    });
    await t.test('empty results return feedback without locking subsequent searches', async () => {
      await page.setContent(fixture('<p role="status">No results found</p>'));
      const field = page.getByRole('combobox');
      await field.fill('SHIATS');
      assert.equal((await dropdownFeedback(field, 'SHIATS', 300))?.status, 'no-results');
      await field.fill('SHIATS');
      assert.equal((await dropdownFeedback(field, 'SHIATS', 300))?.status, 'no-results');
      await page.locator('#choices').evaluate(node => node.innerHTML = '<div role="option">SHIATS</div>');
      assert.equal((await dropdownFeedback(field, 'SHIATS', 300))?.selected, true);
    });
    await t.test('loading and silent empty menus are bounded and never selected', async () => {
      await page.setContent(fixture('<span role="progressbar">Loading</span>'));
      const field = page.getByRole('combobox');
      await field.fill('SHIATS');
      assert.equal((await dropdownFeedback(field, 'SHIATS', 150))?.status, 'loading');
      await page.locator('#choices').evaluate(node => node.replaceChildren());
      const start = Date.now();
      assert.equal((await dropdownFeedback(field, 'SHIATS', 150))?.status, 'empty');
      assert.ok(Date.now() - start < 1500);
    });
    await t.test('unrelated, disabled, ambiguous and non-exact options are not chosen', async () => {
      for (const choices of ['<div role="option">Unrelated University</div>', '<div role="option" aria-disabled="true">SHIATS</div>', option + option, '<div role="option">SHIATS University</div>']) {
        await page.setContent(fixture(choices) + '<div role="listbox"><div role="option">SHIATS</div></div>');
        const field = page.getByRole('combobox');
        await field.fill('SHIATS');
        assert.equal((await dropdownFeedback(field, 'SHIATS', 300))?.selected, false);
        assert.equal(await field.getAttribute('aria-invalid'), 'true');
      }
    });
    await t.test('option click without committed value stays unconfirmed', async () => {
      await page.setContent(fixture(option).replace(/<script>.*?<\/script>/s, ''));
      const field = page.getByRole('combobox');
      await field.fill('SHIATS');
      assert.equal((await dropdownFeedback(field, 'SHIATS', 300))?.status, 'selection-unconfirmed');
    });
    await t.test('open shadow roots and iframe-owned menus stay scoped', async () => {
      await page.setContent('<div id="host"></div><div role="option">SHIATS</div>');
      await page.locator('#host').evaluate((node, html) => node.attachShadow({ mode: 'open' }).innerHTML = html, fixture(option));
      // Scripts assigned through innerHTML do not execute; use a real DOM handler.
      await page.locator('#choices').evaluate(node => node.addEventListener('click', () => {
        const root = node.getRootNode() as ShadowRoot;
        const field = root.querySelector('input')!;
        field.value = 'SHIATS'; field.setAttribute('aria-expanded', 'false'); field.setAttribute('aria-invalid', 'false');
        (node as HTMLElement).hidden = true;
      }));
      const field = page.getByRole('combobox');
      await field.fill('SHIATS');
      // Inline handler uses document, so expose the menu explicitly in this fixture.
      await page.locator('#choices').evaluate(node => (node as HTMLElement).hidden = false);
      assert.equal((await dropdownFeedback(field, 'SHIATS', 300))?.selected, true);
      await page.setContent('<iframe></iframe><div id="choices" role="listbox"><div role="option">SHIATS</div></div>');
      const frame = page.frames()[1];
      await frame.setContent(fixture(option));
      await frame.getByRole('combobox').fill('SHIATS');
      assert.equal((await dropdownFeedback(frame.getByRole('combobox'), 'SHIATS', 300))?.selected, true);
    });
    await t.test('ordinary and private inputs never invoke dropdown selection', async () => {
      await page.setContent('<input id="plain"><input id="secret" role="combobox" type="password" aria-controls="choices">');
      assert.equal(await dropdownFeedback(page.locator('#plain'), 'SHIATS'), undefined);
      assert.equal(await dropdownFeedback(page.locator('#secret'), 'secret'), undefined);
    });
    await t.test('explicit native select uses the same verified feedback', async () => {
      await page.setContent(fixture(option));
      await nativeSelect(page.getByRole('combobox'), 'SHIATS');
      assert.equal(await page.getByRole('combobox').getAttribute('aria-invalid'), 'false');
    });
  } finally { await browser.close(); }
});
