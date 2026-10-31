import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-private-auth-'));
Object.assign(process.env, { DATA_DIR: directory, FORM_CORPUS_DIR: join(directory, 'corpus'), CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false', SITE_AUTH_SECRET: 'fixture-only' });
const { observe, renderObservation } = await import('./observe.js');
const { fillEmailedCode, doCompleteAuthentication } = await import('./authentication.js');
const { nativeInspect, nativeSnapshot } = await import('./native-browser.js');
const { questionEvidenceIssue } = await import('./question-evidence.js');
const { recordFormPage } = await import('../form-corpus.js');
const { readSavedForm } = await import('./saved-form.js');
const { authenticationValue } = await import('../site-auth.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const html = '<style>body{font:18px monospace}label{display:block;margin:8px}input{font:18px monospace;width:240px}.digits input{width:35px}iframe{height:80px;width:600px}</style><main>'
    + '<label>Verification code<input id=otp autocomplete=one-time-code></label><label>Password<input id=password type=text autocomplete=new-password></label>'
    + '<label>Code<input name=otp value=NAME42></label><label>Value<input name=password value=NamedPassword64></label>'
    + '<label>Postcode<input id=postcode value=2000></label><label>Security policy code<input id=business value=BUSINESS-42></label><label>Date of birth<input id=dob type=date value=1990-01-02></label>'
    + '<div class=digits>' + Array.from({ length: 6 }, (_, i) => `<label>Digit ${i + 1}<input maxlength=1></label>`).join('') + '</div>'
    + '<p id=echo></p><iframe srcdoc="<label>Verification code<input autocomplete=one-time-code value=FR8X29></label>"></iframe></main>';
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://privacy.fixture.invalid/form');
  await page.frameLocator('iframe').locator('input').waitFor();
  await page.locator('#otp').fill('752846'); await page.locator('#password').fill('VisiblePassword83!');
  const digitFields = Array.from({ length: 6 }, (_, i) => ({ ref: `digit${i}`, label: `Digit ${i + 1}`, kind: 'text' as const, required: true }));
  assert.equal(await fillEmailedCode(page, digitFields, '638491', digitFields.map((_, i) => page.locator('.digits input').nth(i))), true);
  await page.locator('#echo').evaluate(node => { node.textContent = 'Entered code: 638491'; });
  await page.locator('#otp').focus();
  await page.evaluate(() => {
    const state = window as unknown as { privateCaptureEvents: string[] };
    state.privateCaptureEvents = [];
    document.addEventListener('focusout', () => state.privateCaptureEvents.push('focusout'));
    document.addEventListener('change', () => state.privateCaptureEvents.push('change'));
  });
  const first = await observe(page, { screenshot: true });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'otp', 'private screenshot capture preserves the focused authentication control');
  assert.deepEqual(await page.evaluate(() => (window as unknown as { privateCaptureEvents: string[] }).privateCaptureEvents), [], 'masking emits no focusout or change events');
  const textOnly = { ...first, screenshot: undefined };
  for (const secret of ['752846', 'VisiblePassword83!', '638491', 'FR8X29', 'NAME42', 'NamedPassword64']) {
    assert.ok(!JSON.stringify(textOnly).includes(secret), 'regular fields, frame text and surface copy keep authentication values private');
    assert.ok(!renderObservation(first).includes(secret));
    assert.ok(!(await nativeSnapshot(page)).includes(secret));
    assert.ok(!JSON.stringify(await nativeInspect(page.locator('input'))).includes(secret));
  }
  assert.equal(first.fields.find(field => field.label === 'Verification code')?.privateKind, 'verification-code');
  assert.equal(first.fields.filter(field => field.label.startsWith('Digit ')).every(field => field.privateKind === 'verification-code'), true);
  for (const label of ['Postcode', 'Security policy code', 'Date of birth']) assert.equal(first.fields.find(field => field.label === label)?.sensitive, false);
  const codeField = first.fields.find(field => field.label === 'Verification code')!;
  assert.equal(authenticationValue(codeField, { name: 'Fixture', email: 'fixture@invalid', phone: '' } as never, page.url()), null, 'OTP sensitivity never selects a site password');
  const beforeAuthentication = await page.locator('#otp').inputValue();
  await doCompleteAuthentication({ page, observation: first, profile: { name: 'Fixture', email: 'fixture@invalid', phone: '' }, actions: [], log: () => {} } as never,
    { targets: [{ selector: '#otp' }], purpose: 'create_account' });
  assert.equal(await page.locator('#otp').inputValue(), beforeAuthentication, 'native authentication targets preserve the verification-code kind and cannot receive a generated password');
  assert.ok(await questionEvidenceIssue({ page, observation: first } as never, [{ field_ref: codeField.ref, form_quote: codeField.label }]), 'private auth codes cannot enter the saved answer-bank question flow');
  const saved = await readSavedForm(page);
  assert.ok(saved.fields.some(field => field.label === 'Security policy code'), 'ordinary code/business answers remain in canonical form evidence');
  assert.ok(!JSON.stringify(saved).includes('638491'));
  await recordFormPage(page, first);
  const corpus = readdirSync(join(directory, 'corpus')).flatMap(platform => readdirSync(join(directory, 'corpus', platform)).filter(name => name.endsWith('.gz')).map(name => gunzipSync(readFileSync(join(directory, 'corpus', platform, name))).toString())).join('\n');
  assert.ok(corpus.length);
  for (const secret of ['752846', 'VisiblePassword83!', '638491', 'FR8X29', 'NAME42', 'NamedPassword64']) assert.ok(!corpus.includes(secret), 'offline HTML never persists live private authentication values');
  await page.locator('#otp').fill('193572'); await page.locator('#password').fill('ChangedPassword94!');
  await page.frameLocator('iframe').locator('input').fill('AB4W83');
  assert.equal(await fillEmailedCode(page, digitFields, '927364', digitFields.map((_, i) => page.locator('.digits input').nth(i))), true);
  await page.locator('#echo').evaluate(node => { node.textContent = 'Entered code: 927364'; });
  await page.locator('#otp').focus();
  const second = await observe(page, { screenshot: true });
  assert.ok(first.screenshot && second.screenshot);
  assert.equal(first.screenshot, second.screenshot, 'changing only private input values and their echo text does not change masked screenshot pixels, including frames');
  assert.equal(await page.locator('#otp').inputValue(), '193572');
  assert.equal(await page.locator('#password').inputValue(), 'ChangedPassword94!');
  assert.equal(await page.locator('[data-owtomate-private-mask]').count(), 0, 'temporary privacy overlays/styles are removed');
  assert.equal(await page.frameLocator('iframe').locator('[data-owtomate-private-mask]').count(), 0);
  writeFileSync(resolve(directory, 'private-auth-masked.jpg'), Buffer.from(first.screenshot.split(',')[1], 'base64'));
  // Optional review artifact lives in the workspace, while all fixture data is ephemeral.
  if (process.env.PRIVATE_AUTH_REVIEW_IMAGE) writeFileSync(process.env.PRIVATE_AUTH_REVIEW_IMAGE, Buffer.from(first.screenshot.split(',')[1], 'base64'));
  console.log('PASS: private OTP/password fields, split digits, frames, native snapshots, canonical readback, corpus HTML and transient screenshot masks; business/DOB fields stay usable.');
} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
