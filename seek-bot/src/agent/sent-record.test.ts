import assert from 'node:assert/strict';
import { chromium } from 'patchright';

/**
 * The application's record is what the form held when it was sent: a letter
 * corrected on the form after the first draft, an answer changed after it
 * was first given (Arinco, 4 Oct 2026).
 */
process.env.CELERIS_API_KEY = 'fixture-only';
const { recordWhatWasSent } = await import('./tools.js');

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  await page.setContent(`<form>
    <label>Cover Letter <textarea data-owt-letter="1">Dear Hiring Team, I can start after one week's notice.</textarea></label>
    <label>Notice period <input value="1 week"></label>
  </form>`);
  const ctx = {
    page,
    coverLetter: 'Dear Hiring Team, I am available immediately.',
    captured: [{ question: 'Notice period', answer: 'Immediately' }, { question: 'Not on this page', answer: 'kept' }],
    log: () => {},
  } as unknown as Parameters<typeof recordWhatWasSent>[0];
  await recordWhatWasSent(ctx);
  assert.equal(ctx.coverLetter, "Dear Hiring Team, I can start after one week's notice.", 'the letter the form holds is the one recorded');
  assert.equal(ctx.captured[0].answer, '1 week', 'an answer changed on the form is recorded as sent');
  assert.equal(ctx.captured[1].answer, 'kept', 'an answer from an earlier page is left as given');
  console.log('PASS: the application record is what the form held when it was sent');
} finally {
  await browser.close();
}
