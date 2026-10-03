import assert from 'node:assert/strict';
import { chromium, type Page } from 'patchright';
import { hasCaptchaSurface } from './detect.js';

/**
 * hCaptcha counts as a wall only when it is in front of the person. Fixture
 * pages served under a form host, with hCaptcha's frames served as blanks
 * under its own host, laid out the way Lever's invisible widget (enclave
 * frames, hidden) and the classic widget (checkbox, parked puzzle) are.
 */
const frame = (hash: string, style: string) =>
  `<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=${hash}" style="${style}"></iframe>`;
const form = (inner: string) => `<!doctype html><main><form><label>Name <input></label>
  <div class="h-captcha" data-sitekey="e33f87f8-88ec-4e1a-9a13-df9bbb1d8120">${inner}</div>
  <button>Submit application</button></form></main>`;

const pages: Record<string, string> = {
  // Lever today: enclave frames covering the screen but hidden until a puzzle is needed.
  invisibleEnclave: form(frame('enclave', 'position:fixed;top:0;left:0;width:100vw;height:100vh;visibility:hidden;border:0')
    + frame('enclave', 'position:fixed;top:0;left:0;width:100vw;height:100vh;visibility:hidden;border:0')),
  // Classic invisible: the widget frame and a puzzle parked off the page.
  invisibleClassic: form(frame('checkbox-invisible', 'width:0;height:0;border:0')
    + `<div style="position:absolute;top:-10000px;visibility:hidden">${frame('challenge', 'width:400px;height:600px')}</div>`),
  // The puzzle has opened over the form.
  puzzleOpen: form(frame('enclave', 'position:fixed;top:0;left:0;width:100vw;height:100vh;visibility:visible;border:0')),
  // A checkbox to tick, even far down a long form.
  checkbox: `<div style="height:2400px"></div>` + form(frame('checkbox', 'width:303px;height:78px;border:0')),
  // A checkbox inside a faded container is not showing.
  faded: form(`<div style="opacity:0">${frame('checkbox', 'width:303px;height:78px;border:0')}</div>`),
};

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page: Page = await browser.newPage();
  let html = '';
  await page.route('https://jobs.lever.co/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('https://newassets.hcaptcha.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div>hcaptcha</div>' }));
  const check = async (name: string) => {
    html = pages[name];
    await page.goto('https://jobs.lever.co/fixture/1/apply');
    await page.waitForTimeout(300);
    return hasCaptchaSurface(page);
  };
  assert.equal(await check('invisibleEnclave'), false, "Lever's hidden invisible hCaptcha does not stop the application");
  assert.equal(await check('invisibleClassic'), false, 'a parked puzzle and an invisible widget are not a wall');
  assert.equal(await check('puzzleOpen'), true, 'an opened puzzle is a wall');
  assert.equal(await check('checkbox'), true, 'a checkbox to tick is a wall, wherever it is on the form');
  assert.equal(await check('faded'), false, 'a faded-out frame is not showing');
  console.log('PASS: hCaptcha stops an application only when a checkbox or puzzle is actually showing');
} finally {
  await browser.close();
}
