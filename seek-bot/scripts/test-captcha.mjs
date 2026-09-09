import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { trySolveCaptcha } from '../dist/captcha.js';
import { hasVisibleCaptcha } from '../dist/browser.js';

const profile = await mkdtemp(join(tmpdir(), 'captcha-bridge-test-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--remote-debugging-port=0'],
});
try {
  const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  process.env.BROWSER_CONNECT_CDP = 'true';
  process.env.CDP_HOST = '127.0.0.1';
  process.env.CDP_PORT = port;
  // Every request is fulfilled locally; no real CAPTCHA provider or job board is contacted.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
    route.request().url().includes('challenges.cloudflare.com')
      ? `<input type="checkbox" onclick="document.querySelector('#success').hidden=false;parent.postMessage('solved','*')"><div id="success" hidden>Success</div>`
      : `<input name="cf-turnstile-response" value=""><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/test"></iframe><script>addEventListener('message', e => {if(e.data==='solved')document.querySelector('input').value='fixture-token'})</script>`,
  }));
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto('http://fixture.test/');
  await second.goto('http://fixture.test/');
  process.env.CAPTCHA_SOLVER = 'off';
  assert.equal(await trySolveCaptcha(second), false);
  process.env.CAPTCHA_SOLVER = 'click';
  assert.equal(await trySolveCaptcha(second), true, 'real Python solver should click the fixture');
  assert.equal(await second.locator('input').inputValue(), 'fixture-token');
  assert.equal(await first.locator('input').inputValue(), '', 'same-URL sibling must remain untouched');
  assert.equal(await hasVisibleCaptcha(second, false), false, 'completed widget is not a blocker');
  assert.equal(await hasVisibleCaptcha(first, false), true, 'unsolved widget remains a blocker');
  assert.equal(await trySolveCaptcha(second), false, 'cooldown prevents repeated attempts');
  assert.equal(context.pages().includes(second), true, 'Python disconnect must leave Chrome open');
  const third = await context.newPage();
  await third.goto('http://fixture.test/');
  process.env.CAPTCHA_PYTHON = 'nonexistent-captcha-python';
  assert.equal(await trySolveCaptcha(third), false, 'missing Python falls back to human');
  console.log('PASS: bridge solve, exact tab, disconnect, disabled mode, cooldown, missing Python');
} finally {
  await context.close();
}
