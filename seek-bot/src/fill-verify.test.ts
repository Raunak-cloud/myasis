import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

/**
 * A filled field is accepted when the form holds the answer, however it
 * shows it, and rejected when it holds something else. Fixtures only.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-fill-verify-'));
process.env.DATA_DIR = directory;
const { observe } = await import('./agent/observe.js');
const { fillField } = await import('./dom.js');

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const accepts = async (html: string, value: string) => {
  await page.setContent(html);
  const [field] = (await observe(page)).fields;
  return fillField(page, field, value, 'type').then(() => true, () => false);
};
const page = await browser.newPage();
try {
  // Salary boxes that keep their own format.
  assert.equal(await accepts('<main><label>Salary expectation *<input oninput="this.value=this.value.replace(/[^0-9]/g, \'\')"></label></main>', '$80,000'), true, 'a digits-only salary box holds $80,000 as 80000');
  assert.equal(await accepts('<main><label>Salary expectation *<input onblur="this.value=Number(this.value.replace(/[^0-9.]/g, \'\')).toFixed(2)"></label></main>', '$80,000'), true, 'a box that adds .00 holds the same amount');
  // A picker that clears its search box and shows the choice beside it.
  assert.equal(await accepts('<main><div class="prompt"><label>Country Phone Code *<input onchange="this.value=\'\'; this.nextElementSibling.textContent=\'1 item selected, Australia (+61)\'"><span></span></label></div><label>Phone<input></label></main>', '+61'), true, 'a cleared picker showing the choice holds it');
  // Ordinary text is still compared as text.
  assert.equal(await accepts('<main><label>Employer<input></label></main>', 'Self-employed'), true);

  // What must still be refused.
  assert.equal(await accepts('<main><label>Salary expectation *<input oninput="this.value=\'90000\'"></label></main>', '$80,000'), false, 'a different amount is a rejection');
  assert.equal(await accepts('<main><div><label>Country Phone Code *<input onchange="this.value=\'\'; this.nextElementSibling.textContent=\'Select one\'"><span></span></label></div><label>Phone<input></label></main>', '+61'), false, 'a cleared picker showing nothing chosen is a rejection');
  assert.equal(await accepts('<main><label>Employer<input oninput="this.value=\'Acme\'"></label></main>', 'Self-employed'), false, 'other text is a rejection');
  assert.equal(await accepts('<main><label>Notice period<input aria-invalid="true" aria-errormessage="e" oninput="this.setAttribute(\'aria-invalid\',\'true\')"></label><p id="e">Enter a number of weeks</p></main>', '2 weeks'), false, 'a field the form says is wrong is a rejection');

  console.log('PASS: answers the form holds in its own format are accepted; different or invalid ones are not');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
