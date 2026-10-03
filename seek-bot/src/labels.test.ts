import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { extractFields } from './dom.js';

/**
 * A field is named by text about it, never by another control's content.
 * Layouts from forms that mislabelled a field on 3 Oct 2026.
 */
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  const labelOf = async (html: string, name: string) => {
    await page.setContent(html);
    const fields = await extractFields(page);
    const field = fields.find((candidate) => candidate.hints?.includes(`name=${name}`));
    assert.ok(field, `the ${name} field is observed`);
    return field!;
  };

  // Zoho Recruit: a salutation dropdown right before the First Name box, the caption above both.
  let field = await labelOf(`<form><div class="row"><span>First Name *</span>
    <div><select name="Salutation"><option>-None-</option><option>Mr.</option></select><input name="First_Name"></div></div></form>`, 'First_Name');
  assert.notEqual(field.label, '-None-', 'another dropdown\'s "-None-" is not a label');
  assert.match(field.label, /First Name/);

  // The same with a custom dropdown component instead of a native select.
  field = await labelOf(`<form><div><lyte-dropdown role="combobox">-None-</lyte-dropdown><input name="First_Name"></div></form>`, 'First_Name');
  assert.ok(!/none/i.test(field.label), `a custom dropdown's text is not a label either (got "${field.label}")`);
  assert.match(field.hints ?? '', /name=First_Name/, 'the field\'s own name goes to the answerer as a hint');

  // A placeholder that is an unset choice is no label.
  field = await labelOf(`<form><input name="Phone_Number" placeholder="Select"></form>`, 'Phone_Number');
  assert.notEqual(field.label, 'Select');

  // A real caption is still used.
  field = await labelOf(`<form><label for="e">Email address</label><input id="e" name="email"></form>`, 'email');
  assert.equal(field.label, 'Email address');

  console.log('PASS: fields are named by captions, never by another control\'s text or an unset choice, and carry their own markup names');
} finally {
  await browser.close();
}
