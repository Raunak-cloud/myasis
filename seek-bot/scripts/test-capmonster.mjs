import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { handleCaptchaWithCapMonster, reportRejectedToken, trySolveCaptcha, watchCaptchas } from '../dist/captcha.js';

// A stand-in for api.capmonster.cloud: no real task is created and nothing is spent.
const calls = [];
let balance = 1;
let failNextTask = false;
let unsolvableTask = 0;
const api = createServer((request, response) => {
  let raw = '';
  request.on('data', chunk => (raw += chunk));
  request.on('end', () => {
    const method = request.url.slice(1);
    const body = JSON.parse(raw);
    calls.push({ method, body });
    let reply;
    if (body.clientKey !== 'fixture-key') reply = { errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST' };
    else if (method === 'createTask' && balance <= 0) reply = { errorId: 1, errorCode: 'ERROR_ZERO_BALANCE' };
    else if (method === 'createTask') {
      const taskId = calls.length;
      if (failNextTask) {
        failNextTask = false;
        unsolvableTask = taskId;
      }
      reply = { errorId: 0, taskId };
    } else if (method === 'getTaskResult' && body.taskId === unsolvableTask) {
      unsolvableTask = 0;
      reply = { errorId: 1, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' };
    } else if (method === 'getTaskResult') {
      reply = { errorId: 0, status: 'ready', solution: { token: `ts-${body.taskId}`, gRecaptchaResponse: `rc-${body.taskId}` } };
    } else reply = { errorId: 0, status: 'success' };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(reply));
  });
});
await new Promise(done => api.listen(0, '127.0.0.1', done));
process.env.CAPMONSTER_API_URL = `http://127.0.0.1:${api.address().port}`;
process.env.CAPMONSTER_API_KEY = 'fixture-key';

const TS_KEY = '0x4AAAAAAAfixtureKey000000';
const RC_KEY = '6LfixtureRecaptchaKey';
// Google's hidden iframe: asked for a token, it POSTs the action (protobuf field 8) to /reload and hands back what it gets.
const ANCHOR = `<script>addEventListener('message', async (event) => {
  if (!event.data?.action) return;
  const action = new TextEncoder().encode(event.data.action);
  const reply = await (await fetch('/recaptcha/api2/reload?k=' + new URLSearchParams(location.search).get('k'),
    { method: 'POST', body: new Uint8Array([0x42, action.length, ...action]) })).text();
  parent.postMessage({ token: JSON.parse(reply.slice(reply.indexOf('[')))[1] }, '*');
});</script>`;
const invisible = script => `${script}<iframe id="anchor" src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=${RC_KEY}&size=invisible"></iframe>
  <button onclick="document.getElementById('anchor').contentWindow.postMessage({ action: 'apply_submit' }, '*')">Apply</button>
  <script>addEventListener('message', event => { if (event.data?.token) document.title = 'token:' + event.data.token })</script>`;
const PAGES = {
  'v3.test': invisible(`<script src="https://www.google.com/recaptcha/api.js?render=${RC_KEY}"></script>`),
  'v2-invisible.test': invisible(''),
  'turnstile.test': `<form><div class="cf-turnstile" data-sitekey="${TS_KEY}" data-action="apply" data-callback="onSolved"></div>
    <input name="cf-turnstile-response"><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/${TS_KEY}/auto/"></iframe></form>
    <script>window.onSolved = token => { document.title = 'callback:' + token }</script>`,
  // Indeed wraps a regular Turnstile in generic challenge ids. This must not
  // be mistaken for a full Cloudflare interstitial, which requires a reload.
  'indeed-challenge.test': `<title>Additional Verification Required</title><form id="challenge-form"><div id="challenge-stage">
    <div class="cf-turnstile" data-sitekey="${TS_KEY}" data-callback="onSolved"></div>
    <input name="cf-turnstile-response"><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/${TS_KEY}/auto/"></iframe>
    </div></form><script>window.onSolved = token => { document.title = 'callback:' + token }</script>`,
  'unknown-captcha.test': '<title>CAPTCHA verification</title><div class="h-captcha" style="width:300px;height:80px"></div>',
  // The widget sits inside an embedded form, as ATS forms usually do.
  'employer.test': `<h1>Careers</h1><iframe src="http://recaptcha.test/"></iframe>`,
  'recaptcha.test': `<textarea name="g-recaptcha-response"></textarea><iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=${RC_KEY}&size=normal"></iframe>
    <script>window.___grecaptcha_cfg = { clients: { 0: { a: { b: { sitekey: '${RC_KEY}', callback: token => { document.title = 'callback:' + token } } } } } }</script>`,
  'challenge.test': `<title>Just a moment...</title><div id="challenge-stage"></div>
    <script>turnstile.render('#challenge-stage', { sitekey: '${TS_KEY}', action: 'managed', cData: 'cd-1', chlPageData: 'pd-1',
      callback: token => { document.body.innerHTML = '<h1 id="cleared">' + token + '</h1>' } })</script>`,
};

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'capmonster-test-')), { channel: 'chrome', headless: true });
try {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const google = url.pathname.endsWith('/reload') ? `)]}'\n["rresp","native-token",null,120]` : url.pathname.endsWith('/anchor') ? ANCHOR : '';
    return route.fulfill({ contentType: 'text/html', body: url.hostname === 'www.google.com' ? google : PAGES[url.hostname] ?? '' });
  });
  const open = async (host) => {
    const page = await context.newPage();
    await page.goto(`http://${host}/`);
    return page;
  };
  const task = () => calls.findLast(call => call.method === 'createTask').body.task;

  process.env.CAPTCHA_SOLVER = 'off';
  const turnstile = await open('turnstile.test');
  assert.equal(await trySolveCaptcha(turnstile), false, 'off solves nothing');
  assert.equal(calls.length, 0);

  process.env.CAPTCHA_SOLVER = 'click, capmonster';
  assert.equal(await trySolveCaptcha(turnstile), true, 'a removed solver still named in an old .env is ignored');
  assert.deepEqual(task(), { type: 'TurnstileTask', websiteURL: 'http://turnstile.test/', websiteKey: TS_KEY, pageAction: 'apply' });
  assert.match(await turnstile.locator('input').inputValue(), /^ts-\d+$/);
  assert.match(await turnstile.title(), /^callback:ts-/);
  assert.equal(await trySolveCaptcha(turnstile), false, 'cooldown prevents a second paid attempt');

  const indeedChallenge = await open('indeed-challenge.test');
  assert.equal(await trySolveCaptcha(indeedChallenge), true, 'a branded verification page is solved as embedded Turnstile');
  assert.deepEqual(task(), { type: 'TurnstileTask', websiteURL: 'http://indeed-challenge.test/', websiteKey: TS_KEY });
  assert.match(await indeedChallenge.title(), /^callback:ts-/);

  failNextTask = true;
  const retryable = await open('turnstile.test');
  const tasksBeforeRetry = calls.filter(call => call.method === 'createTask').length;
  assert.equal(await trySolveCaptcha(retryable), true, 'a temporary unsolvable result is retried with a fresh task');
  assert.equal(calls.filter(call => call.method === 'createTask').length, tasksBeforeRetry + 2);

  const unknown = await open('unknown-captcha.test');
  assert.equal(await handleCaptchaWithCapMonster(unknown), 'blocked', 'an unknown CAPTCHA is withheld from browser agents');

  process.env.CAPTCHA_SOLVER = 'capmonster';
  const employer = await open('employer.test');
  assert.equal(await trySolveCaptcha(employer), true);
  assert.deepEqual(task(), { type: 'RecaptchaV2Task', websiteURL: 'http://recaptcha.test/', websiteKey: RC_KEY, isInvisible: false });
  const embedded = employer.frames().find(frame => frame.url() === 'http://recaptcha.test/');
  assert.match(await embedded.locator('textarea').inputValue(), /^rc-\d+$/);
  assert.match(await embedded.title(), /^callback:rc-/, 'the callback inside grecaptcha config runs in the widget frame');

  await reportRejectedToken(employer);
  assert.equal(calls.at(-1).method, 'reportIncorrectTokenCaptcha');
  const reports = calls.length;
  await reportRejectedToken(employer);
  assert.equal(calls.length, reports, 'a token is reported once');

  const challenge = await open('challenge.test');
  assert.equal(await trySolveCaptcha(challenge), true);
  const sent = task();
  assert.deepEqual({ ...sent, userAgent: undefined }, { type: 'TurnstileTask', cloudflareTaskType: 'token', websiteURL: 'http://challenge.test/',
    websiteKey: TS_KEY, pageAction: 'managed', data: 'cd-1', pageData: 'pd-1', userAgent: undefined });
  assert.match(sent.userAgent, /^Mozilla\/5\.0 /);
  assert.match(await challenge.locator('#cleared').innerText(), /^ts-\d+$/);
  await challenge.reload();
  assert.equal(await challenge.evaluate(() => Object.getOwnPropertyDescriptor(window, 'turnstile') === undefined, undefined, undefined, false), true,
    'the stand-in does not outlive the solve');

  // reCAPTCHA v3 shows no wall: the token is swapped inside Google's own /reload response.
  process.env.CAPMONSTER_RECAPTCHA_V3 = 'true';
  watchCaptchas(context);
  const v3 = await open('v3.test');
  await v3.getByRole('button').click();
  await v3.waitForFunction(() => document.title.startsWith('token:'));
  assert.match(await v3.title(), /^token:rc-\d+$/, 'CapMonster token replaces the native one');
  assert.deepEqual(task(), { type: 'RecaptchaV3TaskProxyless', websiteURL: 'http://v3.test/', websiteKey: RC_KEY, pageAction: 'apply_submit', minScore: 0.7, isEnterprise: false });
  const solves = calls.filter(call => call.method === 'createTask').length;
  const v2 = await open('v2-invisible.test');
  await v2.getByRole('button').click();
  await v2.waitForFunction(() => document.title.startsWith('token:'));
  assert.equal(await v2.title(), 'token:native-token', 'an invisible v2 widget keeps its own token');
  assert.equal(calls.filter(call => call.method === 'createTask').length, solves, 'and costs nothing');

  balance = 0;
  const broke = await open('turnstile.test');
  assert.equal(await trySolveCaptcha(broke), false, 'an empty balance hands off to a human');
  const before = calls.length;
  assert.equal(await trySolveCaptcha(await open('turnstile.test')), false);
  assert.equal(calls.length, before, 'an account error stops further API calls for the run');

  console.log('PASS: CapMonster-only guard, Turnstile, Indeed branded challenge, temporary-error retry, embedded reCAPTCHA v2, Cloudflare challenge, reCAPTCHA v3 swap, cooldown, token report, account-error shutoff');
} finally {
  await context.close();
  api.close();
}
