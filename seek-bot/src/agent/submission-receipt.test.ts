import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { isApplicationReceipt, submissionReceipt } from './submission-receipt.js';

for (const quote of ['Please wait...', 'Apply', 'Application submitting', 'Your application was not submitted', 'Once your application is submitted', 'No errors appeared', 'Account created successfully']) assert.equal(isApplicationReceipt(quote), false, quote);
for (const quote of ['Thanks for applying', 'Your application for Sales Assistant has been submitted', 'We have received your application']) assert.equal(isApplicationReceipt(quote), true, quote);
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
  await page.setContent('<main>Thank you for applying. Your application has been successfully submitted.</main>');
  assert.ok(await submissionReceipt(page, 'Your application has been successfully submitted.'));
  await page.setContent('<main>Application sent</main>');
  assert.ok(await submissionReceipt(page, 'Application sent'), 'fresh reads do not depend on an old observation');
  await page.setContent('<iframe srcdoc="<main>Application received: FRAME123</main>"></iframe>');
  await page.frameLocator('iframe').getByText('Application received: FRAME123').waitFor();
  assert.ok(await submissionReceipt(page, 'Application received: FRAME123'), 'actual frame receipts remain supported');
  await page.locator('iframe').evaluate(node => (node as HTMLElement).style.display = 'none');
  assert.equal(await submissionReceipt(page, 'Application received: FRAME123'), null);
  console.log('PASS: pending states, hallucinations, hidden/editable text and rejection cannot confirm; fresh real receipts and visible frames can. No real employer submission.');
} finally { await browser.close(); }
