import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'patchright';
import { sendBrowserHrEmail, hrMailBody, reconcileHrEmailOnPage, type BrowserHrMail } from './hr-email-browser.js';

const executablePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome-stable');
const mail: BrowserHrMail = { id: 'fixture-outreach', to: 'hr@fixture.invalid', subject: 'Analyst application', body: 'Hello hiring team,\n\nI applied for the Analyst role.\n\nTaylor', createdAt: '2026-11-16T00:00:00Z' };

test('real browser fixtures send exact plain-text HR message and refuse mismatched recipients/accounts', { skip: !existsSync(executablePath), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  let externalRequests = 0;
  await context.route('**/*', route => { externalRequests++; return route.abort(); });
  const page = await context.newPage();
  const fixture = async (opts: { from?: string; recipient?: string; bodyChange?: boolean; receipt?: boolean } = {}) => {
    await page.setContent(`<button id="compose">Compose</button><section id="dialog" role="dialog" hidden>
      <input name="from" value="${opts.from || 'candidate@fixture.invalid'}"><input name="to"><input name="subjectbox">
      <div role="textbox" contenteditable="true"></div><span id="chip"></span><button id="send">Send</button></section><div id="result"></div>
      <script>document.body.dataset.sends='0';document.querySelector('#compose').onclick=()=>document.querySelector('#dialog').hidden=false;
      document.querySelector('[name=to]').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();document.querySelector('#chip').setAttribute('email',${JSON.stringify(opts.recipient || mail.to)});}};
      ${opts.bodyChange ? "document.querySelector('[contenteditable]').oninput=e=>e.target.innerText='changed';" : ''}
      document.querySelector('#send').onclick=()=>{document.body.dataset.sends=String(Number(document.body.dataset.sends)+1);${opts.receipt === false ? '' : "document.querySelector('#result').innerHTML='<div role=alert>Message sent</div>';"}};</script>`);
  };
  try {
    await fixture();
    const receipt = await sendBrowserHrEmail(page, mail, 'candidate@fixture.invalid');
    assert.match(receipt.id, /^browser_HR-/);
    assert.equal((await page.locator('[contenteditable]').innerText()).replace(/\n{3,}/g, '\n\n'), hrMailBody(mail));
    assert.equal(await page.locator('body').getAttribute('data-sends'), '1');
    for (const opts of [{ from: 'other@fixture.invalid' }, { recipient: 'wrong@fixture.invalid' }, { bodyChange: true }]) {
      await fixture(opts);
      await assert.rejects(sendBrowserHrEmail(page, mail, 'candidate@fixture.invalid'), (error: any) => error.code === 'unapproved');
      assert.equal(await page.locator('body').getAttribute('data-sends'), '0');
    }
    await fixture({ receipt: false });
    await assert.rejects(sendBrowserHrEmail(page, mail, 'candidate@fixture.invalid'), (error: any) => error.code === 'uncertain');
    assert.equal(await page.locator('body').getAttribute('data-sends'), '1', 'a lost receipt does not click Send again');
    assert.equal(externalRequests, 0, 'the simulation cannot send an actual email or call Gmail');
  } finally { await context.close(); await browser.close(); }
});

test('real browser Sent reconciliation requires the exact reference, sender, subject and body', { skip: !existsSync(executablePath), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  let state = { account: 'candidate@fixture.invalid', sender: 'candidate@fixture.invalid', subject: mail.subject, body: hrMailBody(mail), empty: false };
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  let fulfilled = 0;
  await context.route('**/*', async route => {
    assert.equal(new URL(route.request().url()).hostname, 'mail.google.com');
    fulfilled++;
    await route.fulfill({ contentType: 'text/html', body: `<a aria-label="Google Account: Candidate (${escape(state.account)})"></a><div role="main" id="main"></div><script>
      const main=document.querySelector('#main');
      if(location.hash.startsWith('#search'))main.innerHTML=${JSON.stringify(state.empty ? '<div role="grid">No conversations found</div>' : '<table><tr data-legacy-thread-id="fixtureSent"><td>Result</td></tr></table>')};
      else main.innerHTML=${JSON.stringify(`<h2>${escape(state.subject)}</h2><div data-message-id="fixtureMessage"><span email="${escape(state.sender)}"></span><div class="a3s" style="white-space:pre-wrap">${escape(state.body)}</div></div>`)};
      </script>` });
  });
  const page = await context.newPage();
  try {
    const found = await reconcileHrEmailOnPage(page, mail, 'candidate@fixture.invalid');
    assert.equal(found?.threadId, 'fixtureSent');
    const baseline = { ...state };
    for (const patch of [{ body: mail.body }, { sender: 'someone@fixture.invalid' }, { subject: 'Another role' }, { empty: true }]) {
      state = { ...baseline, ...patch };
      assert.equal(await reconcileHrEmailOnPage(page, mail, 'candidate@fixture.invalid'), null);
    }
    state = { ...baseline, account: 'other@fixture.invalid' };
    await assert.rejects(reconcileHrEmailOnPage(page, mail, 'candidate@fixture.invalid'), (error: any) => error.code === 'reconnect');
    assert.ok(fulfilled > 0, 'all Gmail pages were intercepted locally; no actual mailbox was accessed');
  } finally { await context.close(); await browser.close(); }
});
