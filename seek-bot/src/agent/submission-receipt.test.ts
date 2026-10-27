import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { submissionReceipt } from './submission-receipt.js';

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  await page.setContent('<main><button disabled>Please wait...</button><p hidden>Application received</p><textarea>Application received</textarea><div contenteditable>Application received</div></main>');
  assert.equal(await submissionReceipt(page, 'Please wait...'), null);
  assert.equal(await submissionReceipt(page, 'Application received'), null, 'hidden templates and editable answers cannot prove receipt');
  await page.setContent('<main>Your application was not submitted. Try again.</main>');
  assert.equal(await submissionReceipt(page, 'Application was submitted'), null, 'a hallucinated positive paraphrase cannot match the actual rejection');
  await page.setContent('<main>Once your application is submitted you will receive an email.</main>');
  assert.equal(await submissionReceipt(page, 'application is submitted'), null, 'a truncated quote from instructions is not receipt');
  await page.setContent('<main>Application submitted unsuccessfully.</main>');
  assert.equal(await submissionReceipt(page, 'Application submitted'), null, 'a truncated quote cannot hide rejection');
  const employerMessage = 'Congratulations! You have applied to a new job as Sandwich Artist at the selected store.';
  await page.setContent(`<main><h1>${employerMessage}</h1><p>Check your email for confirmation.</p></main>`);
  assert.ok(await submissionReceipt(page, employerMessage), 'novel employer wording is grounded without an English success phrase allowlist');
  await page.setContent('<main>Thank you for applying. Your application has been successfully submitted.</main>');
  assert.ok(await submissionReceipt(page, 'Your application has been successfully submitted.'));
  await page.setContent('<main>Application sent</main>');
  assert.ok(await submissionReceipt(page, 'Application sent'), 'fresh reads do not depend on an old observation');
  await page.setContent('<iframe srcdoc="<main>Application received: FRAME123</main>"></iframe>');
  await page.frameLocator('iframe').getByText('Application received: FRAME123').waitFor();
  assert.ok(await submissionReceipt(page, 'Application received: FRAME123'), 'actual frame receipts remain supported');
  await page.locator('iframe').evaluate(node => (node as HTMLElement).style.display = 'none');
  assert.equal(await submissionReceipt(page, 'Application received: FRAME123'), null);
  console.log('PASS: control-only states, invented/truncated quotes and hidden/editable text rejected; complete fresh employer messages and visible frames grounded without success phrase rules. No real employer submission.');
} finally { await browser.close(); }
