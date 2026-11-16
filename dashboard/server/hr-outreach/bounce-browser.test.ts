import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { BrowserHrMail } from '../../../seek-bot/src/hr-email-browser.js';
import { hrMailBody } from '../../../seek-bot/src/hr-email-browser.js';
import { readHrBounceMessagesOnPage } from './bounce-browser.js';
const { chromium } = createRequire(import.meta.url)('../../../seek-bot/node_modules/patchright') as typeof import('../../../seek-bot/node_modules/patchright/index.js');
const executablePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome-stable');
const account = 'candidate@example.test', mail: BrowserHrMail = { id: 'fixture-bounce', to: 'careers@employer.org', subject: 'Fixture application', body: 'Hello hiring team,\n\nI applied for the role.\n\nCandidate', createdAt: '2026-11-16T00:00:00Z' };
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

test('browser delivery reader expands delayed collapsed originals and reads each Gmail raw view without mail actions', { skip: !existsSync(executablePath), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext(); let sendActions = 0, externalRequests = 0, rawReads = 0;
  const raw = (id: string) => `From: ${id === 'sent' ? account : 'postmaster@employer.org'}\r\nTo: ${id === 'sent' ? mail.to : account}\r\nSubject: ${mail.subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\n${id === 'sent' ? hrMailBody(mail) : 'Delivery notification'}`;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mail.google.com') { externalRequests++; return route.abort(); }
    if (url.pathname === '/original') { rawReads++; return route.fulfill({ contentType: 'text/html', body: `<pre id="raw_message_text">${escape(raw(url.searchParams.get('message')!))}</pre>` }); }
    return route.fulfill({ contentType: 'text/html', body: `<a aria-label="Google Account: Candidate (${account})"></a><input aria-label="Search mail"><main role="main" id="main">Loading mailbox</main><div role="menu" hidden><a role="menuitem">Show original</a></div><script>
      document.body.dataset.sends='0';
      function menu(id){const m=document.createElement('div');m.setAttribute('role','menu');m.innerHTML='<a role="menuitem" href="https://mail.google.com/original?message='+id+'" target="_blank">Show original</a>';m.querySelector('a').onclick=()=>setTimeout(()=>m.remove(),0);document.body.append(m);}
      if(location.hash.startsWith('#search/')){document.querySelector('input').value=decodeURIComponent(location.hash.slice(8));document.querySelector('#main').innerHTML='No messages matched your search';setTimeout(()=>{document.querySelector('#main').innerHTML='<div role="grid"><table><tr data-legacy-thread-id="fixtureThread"><td>Matching result</td></tr></table></div>';},150);}
      else {document.querySelector('#main').innerHTML=${JSON.stringify(`<h2>${escape(mail.subject)}</h2><div id="messages"></div>`)};setTimeout(()=>{document.querySelector('#messages').innerHTML=${JSON.stringify(`<button id="expand" aria-label="Expand all">Expand all</button>
        <section data-message-id="sent"><span email="${account}"></span><div class="a3s" hidden>${escape(hrMailBody(mail))}</div><button hidden aria-label="More message options" onclick="menu('sent')">More</button></section>
        <section data-message-id="dsn"><span email="postmaster@employer.org"></span><div class="a3s">Delivery report <button aria-label="More message options" onclick="document.body.dataset.sends=String(Number(document.body.dataset.sends)+1)">Malicious body control</button></div><button aria-label="More message options" onclick="menu('dsn')">More</button></section>`)};document.querySelector('#expand').onclick=()=>{setTimeout(()=>{document.querySelectorAll('#messages [hidden]').forEach(n=>n.hidden=false);document.querySelector('#expand').remove();},100);};},150);}
      </script>` });
  });
  const page = await context.newPage();
  try {
    const result = await readHrBounceMessagesOnPage(page, mail, account, { sentAt: '2026-11-16T00:00:00Z' });
    assert.equal(result.length, 2); assert.deepEqual(result.map(item => item.id), ['sent', 'dsn']);
    assert.deepEqual(result[0].labelIds,['SENT']);assert.equal(result[1].labelIds,undefined);
    assert.equal(rawReads, 2); assert.equal(await page.locator('body').getAttribute('data-sends'), '0'); assert.equal(sendActions, 0); assert.equal(externalRequests, 0);
    assert.equal(context.pages().length, 1, 'only its temporary raw-message popups are closed');
    assert.ok(result[0].raw.includes(hrMailBody(mail)));
  } finally { await context.close(); await browser.close(); }
});

test('browser delivery reader refuses a different mailbox before inspecting messages', { skip: !existsSync(executablePath), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<a aria-label="Google Account: Another (another@example.test)"></a><main role="main">Mailbox</main>' }));
  const page = await context.newPage();
  try { await assert.rejects(readHrBounceMessagesOnPage(page, mail, account, { sentAt: mail.createdAt }), (error: any) => error.code === 'reconnect'); }
  finally { await context.close(); await browser.close(); }
});
