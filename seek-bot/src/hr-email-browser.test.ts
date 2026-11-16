import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'patchright';
import { sendBrowserHrEmail, sendExistingBrowserHrDraft, validateExistingBrowserHrDraft, hrMailBody, reconcileHrEmailOnPage, type BrowserHrMail } from './hr-email-browser.js';

const executablePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome-stable');
const mail: BrowserHrMail = { id: 'fixture-outreach', to: 'hr@fixture.invalid', subject: 'Analyst application', body: 'Hello hiring team,\n\nI applied for the Analyst role.\n\nTaylor', createdAt: '2026-11-16T00:00:00Z' };

test('real browser fixtures send exact plain-text HR message and refuse mismatched recipients/accounts', { skip: !existsSync(executablePath), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  let externalRequests = 0;
  await context.route('**/*', route => { externalRequests++; return route.abort(); });
  const page = await context.newPage();
  const fixture = async (opts: { from?: string; accountHeader?: string; recipient?: string; bodyChange?: boolean; receipt?: boolean; sendLabel?: string; missingSend?: boolean; otherDraft?: boolean } = {}) => {
    await page.setContent(`${opts.accountHeader ? `<a aria-label="Google Account: Candidate (${opts.accountHeader})"></a>` : ''}${opts.otherDraft ? '<section id="personal" role="dialog"><input name="subjectbox" value="Personal draft"><div role="textbox" contenteditable="true">Unrelated personal message</div><span email="friend@fixture.invalid"></span></section>' : ''}<button id="compose">Compose</button><section id="dialog" role="dialog" hidden>
      <form><input name="from" type="hidden" value="${opts.from ?? 'candidate@fixture.invalid'}"><input name="to" aria-label="To recipients"><input name="subjectbox"><span id="chip"></span></form>
      <div role="textbox" contenteditable="true"></div><button id="options">Send options</button><button id="scheduled">Schedule send</button><button id="send" ${opts.missingSend?'hidden':''} aria-label="${opts.sendLabel??'Send'}">Send</button></section><div id="result"></div>
      <script>document.body.dataset.sends='0';document.body.dataset.wrongSends='0';document.querySelector('#compose').onclick=()=>document.querySelector('#dialog').hidden=false;
      document.querySelector('#options').onclick=document.querySelector('#scheduled').onclick=()=>document.body.dataset.wrongSends=String(Number(document.body.dataset.wrongSends)+1);
      document.querySelector('[name=to]').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();document.querySelector('#chip').setAttribute('email',${JSON.stringify(opts.recipient || mail.to)});e.target.value='';}};
      ${opts.bodyChange ? "document.querySelector('[contenteditable]').oninput=e=>e.target.innerText='changed';" : ''}
      document.querySelector('#send').onclick=()=>{document.body.dataset.sends=String(Number(document.body.dataset.sends)+1);${opts.receipt === false ? '' : "document.querySelector('#result').innerHTML='<div role=alert>Message sent</div>';"}};</script>`);
  };
  try {
    await fixture();
    const receipt = await sendBrowserHrEmail(page, mail, 'candidate@fixture.invalid');
    assert.match(receipt.id, /^browser_HR-/);
    assert.equal((await page.locator('[contenteditable]').innerText()).replace(/\n{3,}/g, '\n\n'), hrMailBody(mail));
    assert.equal(await page.locator('body').getAttribute('data-sends'), '1');
    await fixture({ from: '', accountHeader: 'candidate@fixture.invalid' });
    assert.match((await sendBrowserHrEmail(page, mail, 'candidate@fixture.invalid')).id, /^browser_HR-/);
    assert.equal(await page.locator('body').getAttribute('data-sends'), '1', 'a fresh empty From field uses the verified account header');
    await fixture({ otherDraft: true });
    assert.match((await sendBrowserHrEmail(page, mail, 'candidate@fixture.invalid')).id, /^browser_HR-/);
    assert.equal(await page.locator('body').getAttribute('data-sends'), '1', 'normal compose sends only its known draft when a distinct personal draft is open');
    assert.equal(await page.locator('#personal input').inputValue(), 'Personal draft');
    assert.equal(await page.locator('#personal [contenteditable]').innerText(), 'Unrelated personal message');
    await assert.rejects(sendExistingBrowserHrDraft(page, mail, 'candidate@fixture.invalid'), (error: any) => error.code === 'unapproved', 'an unknown existing draft still refuses a page with two visible drafts');
    assert.equal(await page.locator('body').getAttribute('data-sends'), '1', 'ambiguous reuse does not click Send again');
    for(const sendLabel of ['Send \u202a(Ctrl-Enter)\u202c','Send (Ctrl-Enter)','Send \u200f(⌘Enter)\u200e']){
      await fixture({sendLabel});
      assert.match((await sendBrowserHrEmail(page,mail,'candidate@fixture.invalid')).id,/^browser_HR-/);
      assert.equal(await page.locator('body').getAttribute('data-sends'),'1');
      assert.equal(await page.locator('body').getAttribute('data-wrong-sends'),'0','Send options and Schedule send are never selected');
    }
    for (const opts of [{ from: 'other@fixture.invalid' }, { from: '', accountHeader: 'other@fixture.invalid' }, { from: '' }, { recipient: 'wrong@fixture.invalid' }, { bodyChange: true }]) {
      await fixture(opts);
      await assert.rejects(sendBrowserHrEmail(page, mail, 'candidate@fixture.invalid'), (error: any) => error.code === 'unapproved');
      assert.equal(await page.locator('body').getAttribute('data-sends'), '0');
    }
    await fixture({missingSend:true});
    await assert.rejects(sendBrowserHrEmail(page,mail,'candidate@fixture.invalid'),(error:any)=>error.code==='reconnect');
    assert.equal(await page.locator('body').getAttribute('data-sends'),'0','a missing primary button is a pre-send failure, not unconfirmed delivery');
    assert.equal(await page.locator('body').getAttribute('data-wrong-sends'),'0');
    await fixture({ receipt: false });
    await assert.rejects(sendBrowserHrEmail(page, mail, 'candidate@fixture.invalid'), (error: any) => error.code === 'uncertain');
    assert.equal(await page.locator('body').getAttribute('data-sends'), '1', 'a lost receipt does not click Send again');
    assert.equal(externalRequests, 0, 'the simulation cannot send an actual email or call Gmail');
  } finally { await context.close(); await browser.close(); }
});

test('existing full-page drafts wait for the editor and send only the exact saved message', { skip: !existsSync(executablePath), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  let externalRequests = 0;
  await context.route('**/*', route => { externalRequests++; return route.abort(); });
  const page = await context.newPage();
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const fixture = async (opts: { account?: string; from?: string; recipient?: string; subject?: string; body?: string; extraDraft?: boolean; extraRecipient?: 'Cc' | 'Bcc'; pendingRecipient?: boolean; delayedEditor?: boolean } = {}) => {
    const editor = `<div role="textbox" aria-label="Message Body" contenteditable="true" style="white-space:pre-wrap">${escape(opts.body ?? hrMailBody(mail))}</div>`;
    await page.setContent(`<a aria-label="Google Account: Candidate (${escape(opts.account ?? 'candidate@fixture.invalid')})"></a>
      <span email="candidate@fixture.invalid"></span><div data-hovercard-id="sidebar@fixture.invalid"></div>
      <form><input name="from" type="hidden" value="${escape(opts.from ?? 'candidate@fixture.invalid')}"><input name="subjectbox" value="${escape(opts.subject ?? mail.subject)}">${opts.extraDraft ? '<input name="subjectbox" value="Other draft">' : ''}
      <input aria-label="To recipients" value="${opts.pendingRecipient ? 'pending@fixture.invalid' : ''}">
      <span email="${escape(opts.recipient ?? mail.to)}" data-hovercard-id="${escape(opts.recipient ?? mail.to)}"></span>
      <div role="listbox"><div role="option" email="suggestion@fixture.invalid" data-hovercard-id="suggestion@fixture.invalid"></div></div>
      ${opts.extraRecipient ? `<div aria-label="${opts.extraRecipient}"><span email="other@fixture.invalid"></span></div>` : ''}</form>
      ${opts.delayedEditor ? '' : editor}<button id="send" aria-label="Send &#x202a;(Ctrl-Enter)&#x202c;">Send</button><div id="result"></div>
      <script>document.body.dataset.sends='0';document.querySelector('#send').onclick=()=>{document.body.dataset.sends=String(Number(document.body.dataset.sends)+1);document.querySelector('#result').innerHTML='<div role=alert>Message sent</div>';};
      ${opts.delayedEditor ? `setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(editor)}),150);` : ''}</script>`);
  };
  try {
    await fixture({ delayedEditor: true, from: '' });
    assert.equal(await page.locator('[role="dialog"], [role="main"]').count(), 0, 'the live full-page draft has neither container');
    await validateExistingBrowserHrDraft(page, mail, 'candidate@fixture.invalid');
    assert.equal(await page.locator('body').getAttribute('data-sends'), '0', 'read-only validation never clicks Send');
    assert.equal(await page.locator('form input[name="subjectbox"]').inputValue(), mail.subject);
    assert.equal(await page.locator('[contenteditable]').innerText(), hrMailBody(mail), 'read-only validation preserves the exact message');
    assert.match((await sendExistingBrowserHrDraft(page, mail, 'candidate@fixture.invalid')).id, /^browser_HR-/);
    assert.equal(await page.locator('body').getAttribute('data-sends'), '1', 'resuming the saved draft clicks Send only once');
    for (const opts of [{ account: 'other@fixture.invalid' }, { from: 'other@fixture.invalid' }, { recipient: 'wrong@fixture.invalid' }, { subject: 'Other role' },
      { body: mail.body }, { extraDraft: true }, { extraRecipient: 'Cc' as const }, { extraRecipient: 'Bcc' as const }, { pendingRecipient: true }]) {
      await fixture(opts);
      await assert.rejects(validateExistingBrowserHrDraft(page, mail, 'candidate@fixture.invalid'), (error: any) => error.code === 'unapproved');
      await assert.rejects(sendExistingBrowserHrDraft(page, mail, 'candidate@fixture.invalid'), (error: any) => error.code === 'unapproved');
      assert.equal(await page.locator('body').getAttribute('data-sends'), '0');
    }
    assert.equal(externalRequests, 0, 'the draft recovery simulation cannot contact Gmail or send an actual email');
  } finally { await context.close(); await browser.close(); }
});

test('real browser Sent reconciliation requires the exact reference, sender, subject and body', { skip: !existsSync(executablePath), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  let state = { account: 'candidate@fixture.invalid', sender: 'candidate@fixture.invalid', subject: mail.subject, body: hrMailBody(mail), empty: false, emptyMessage: 'No conversations found' };
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  let fulfilled = 0;
  await context.route('**/*', async route => {
    assert.equal(new URL(route.request().url()).hostname, 'mail.google.com');
    fulfilled++;
    await route.fulfill({ contentType: 'text/html', body: `<a aria-label="Google Account: Candidate (${escape(state.account)})"></a><div role="main" id="main"></div><script>
      const main=document.querySelector('#main');
      if(location.hash.startsWith('#search'))main.innerHTML=${JSON.stringify(state.empty ? `<div role="grid">${escape(state.emptyMessage)}</div>` : '<table><tr data-legacy-thread-id="fixtureSent"><td>Result</td></tr></table>')};
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
    state={...baseline,empty:true,emptyMessage:'No messages matched your search. Try using search options such as sender, date, size and more.'};
    assert.equal(await reconcileHrEmailOnPage(page,mail,'candidate@fixture.invalid'),null,'the actual Gmail empty result is a completed read, not a 30-second timeout');
    state = { ...baseline, account: 'other@fixture.invalid' };
    await assert.rejects(reconcileHrEmailOnPage(page, mail, 'candidate@fixture.invalid'), (error: any) => error.code === 'reconnect');
    assert.ok(fulfilled > 0, 'all Gmail pages were intercepted locally; no actual mailbox was accessed');
  } finally { await context.close(); await browser.close(); }
});
