import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGmailBrowser, searchBrowserGmail, readBrowserGmail, withGmailBrowser, sendBrowserApplication } from './gmail-browser.js';
import { GmailMcpService } from './gmail-mcp-service.js';
import { GmailMcpClient } from './gmail-mcp-client.js';
import { readVerificationEmailsLocally } from './verification-email-local.js';
import { verificationMessage } from './gmail-mailbox.js';
import type { PreparedApplication } from './application-review-types.js';
// Use a fixed ephemeral loopback port selected by the OS, then release before Chrome binds it.
const { createServer } = await import('node:net');
const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
const port = (listener.address() as { port: number }).port; await new Promise<void>(done => listener.close(() => done()));
const directory = mkdtempSync(join(tmpdir(), 'owtomate-browser-gmail-'));
const context = await chromium.launchPersistentContext(directory, { headless: true, args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
let sends = 0, uploads = 0, confirmed = true, wrongAccount = false, mailboxUnavailable = false, emptySearch = false;
let emptyMessage = 'No conversations found.', relevanceSearch = false, chronological = false, sortRejected = false, sortSelections = 0;
let messageBody = 'Your Fixture verification code: 482913';
const gmailNavigations: string[] = [];
const letter = 'Dear team,\n\nThis is the exact approved cover letter.';
const pageHtml = () => `<!doctype html><a aria-label="Google Account: ${wrongAccount ? 'other' : 'candidate'}@fixture.invalid"></a><main role="main"><table><tr><td data-thread-id="#thread-f:123456789" data-legacy-thread-id="fixturethread">Fixture code</td></tr></table><article data-message-id="message"><h2>Fixture verification</h2><span email="noreply@fixture.invalid"></span><div class="a3s">${messageBody}</div></article></main><button onclick="document.querySelector('[role=dialog]').hidden=false">Compose</button><section role="dialog" hidden><input name="to" onkeydown="if(event.key==='Enter'){const p=document.createElement('span');p.setAttribute('email',this.value);this.parentElement.append(p)}"><input name="subjectbox"><div role="textbox" contenteditable="true"></div><input type="file" multiple onchange="for(const f of this.files){const p=document.createElement('span');p.textContent=f.name;this.parentElement.append(p)}"><button onclick="fetch('/fixture-send',{method:'POST'}).then(()=>{${confirmed ? 'document.body.insertAdjacentHTML(\'beforeend\',\'<p role=status>Message sent</p>\')' : ''}})">Send</button></section>`;
await context.route('**/*', route => {
  if (mailboxUnavailable) return route.abort();
  if (new URL(route.request().url()).pathname === '/fixture-send') { sends++; return route.fulfill({ body: '{}' }); }
  if (new URL(route.request().url()).pathname === '/fixture-sort') { sortSelections++; chronological = !sortRejected; return route.fulfill({ body: '{}' }); }
  let html = pageHtml();
  if (emptySearch) html = html.replace(/<table>.*?<\/table>/, `<p>${emptyMessage}</p>`);
  else if (relevanceSearch) html = html.replace(/<table>.*?<\/table>/, `<button id="sort" onclick="document.getElementById('sort-menu').hidden=false">Showing most ${chronological ? 'recent' : 'relevant'}</button>
    <div id="sort-menu" role="menu" hidden><button role="menuitemradio" onclick="fetch('/fixture-sort').then(()=>{${sortRejected ? '' : "document.getElementById('sort').textContent='Showing most recent';document.getElementById('sort-menu').hidden=true"}})">Most recent Exact matches</button></div>
    <table>${(chronological ? ['newestthread', 'olderthread'] : ['olderthread', 'newestthread']).map(id => `<tr data-legacy-thread-id="${id}"><td>Verification</td></tr>`).join('')}</table>`);
  return route.fulfill({ contentType: 'text/html', body: html });
});
context.on('page', page => {
  page.on('filechooser', () => uploads++);
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) gmailNavigations.push(frame.url()); });
});
const stop = registerGmailBrowser('browser-owner', port, 'candidate@fixture.invalid');
const approvals = Array.from({ length: 5 }, () => randomUUID());
const drafts = new Map<string, PreparedApplication>(approvals.map((id, i) => [id, { id, revision: String(i + 1).repeat(64), coverLetter: letter, email: { to: 'careers@fixture.invalid', subject: `Application ${i}`, attachCoverLetter: true } } as PreparedApplication]));
const receipts = new Map<string, { messageId: string }>();
const gateway = new GmailMcpService({ search: searchBrowserGmail, thread: readBrowserGmail, send: async (owner, id, version) => {
  const draft = drafts.get(id)!; assert.equal(draft.revision, version);
  if (receipts.has(id)) return { ...receipts.get(id)!, alreadySent: true };
  const sent = await withGmailBrowser(owner, page => sendBrowserApplication(page, draft, 'candidate@fixture.invalid', Buffer.from('Exact resume'), 'CV.txt'));
  const receipt = { messageId: sent.id }; receipts.set(id, receipt); return receipt;
} });
const lease = await gateway.grant('browser-owner', 'candidate@fixture.invalid', approvals), client = new GmailMcpClient(lease.connection);
try {
  const threads = await client.search('verification'); assert.equal(threads[0].id, 'fixturethread');
  const readerConnection = await withGmailBrowser('browser-owner', async page => page.context().browser()!);
  await readerConnection.close();
  assert.equal((await client.search('verification'))[0].id, 'fixturethread', 'a dropped reader connection must reconnect instead of poisoning all later mailbox reads');
  assert.ok(gmailNavigations.some(url => url.includes('#search/')), 'search opens the requested view directly, without reading a stale inbox');
  emptySearch = true;
  for (emptyMessage of ['No conversations found.', 'No results found.', 'No conversations match your search.', 'No messages matched your search. Try using search options such as sender, date, size and more.']) {
    assert.deepEqual(await client.search('no matching email'), [], 'an empty mailbox search is a successful empty result');
  }
  emptySearch = false; relevanceSearch = true;
  assert.deepEqual((await client.search('verification')).map(thread => thread.id), ['newestthread', 'olderthread'], 'discard stale relevance-ranked rows after selecting Most recent');
  assert.equal(sortSelections, 1);
  assert.equal((await client.search('verification'))[0].id, 'newestthread');
  assert.equal(sortSelections, 1, 'an already chronological search needs no sort action or extra reload');
  chronological = false; sortRejected = true;
  await assert.rejects(client.search('verification'), /could not finish/, 'failed sort selection must not return relevance-ranked codes');
  sortRejected = false; relevanceSearch = false;
  mailboxUnavailable = true;
  await assert.rejects(client.search('verification'), /Gmail browser request could not finish/, 'navigation failures retain their real error rather than claiming authorization was revoked');
  mailboxUnavailable = false;
  assert.equal((await client.search('verification'))[0].id, 'fixturethread', 'a temporary mailbox failure does not poison later reads');
  const openBefore = context.pages().length;
  await assert.rejects(withGmailBrowser('browser-owner', async () => new Promise<never>(() => {}), '', 500), /reading the requested mailbox view/, 'a stalled read reports its phase instead of poisoning the mailbox queue');
  assert.equal(context.pages().length, openBefore, 'read timeout closes its owned mailbox tab');
  assert.equal((await client.search('verification'))[0].id, 'fixturethread', 'the account can read again after a stalled request');
  let releasePrior!: () => void, priorStarted!: () => void;
  const started = new Promise<void>(resolve => { priorStarted = resolve; });
  const prior = withGmailBrowser('browser-owner', async () => { priorStarted(); await new Promise<void>(resolve => { releasePrior = resolve; }); });
  await started;
  let abandonedStarted = false, nextStarted = false;
  const beforeQueueWarning = console.warn;
  let queueDiagnostic = '';
  try {
    console.warn = (...parts) => { queueDiagnostic = parts.join(' '); };
    await assert.rejects(withGmailBrowser('browser-owner', async () => { abandonedStarted = true; }, '', 100), /waiting for the mailbox reader/);
  } finally { console.warn = beforeQueueWarning; }
  assert.match(queueDiagnostic, /"closed":false/, 'queue waiting is not evidence of a disconnected browser');
  const next = withGmailBrowser('browser-owner', async () => { nextStarted = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(nextStarted, false, 'a timed-out queued read cannot let work overtake a still-running approved operation');
  releasePrior(); await prior; await next;
  assert.equal(abandonedStarted, false, 'expired queued reads never execute later');
  const messages = await client.thread(threads[0].id);
  assert.equal(messages[0].date, undefined, 'a browser read must not invent a delivery timestamp that reverses verification-code order');
  const originalWarn = console.warn;
  let diagnostic = '';
  try {
    console.warn = (...parts) => { diagnostic = parts.join(' '); };
    await assert.rejects(withGmailBrowser('browser-owner', async () => {
      const error = new Error('private-message-body net::ERR_PRIVATE_MESSAGE_BODY'); error.name = 'private-mailbox-name'; throw error;
    }), /while reading the requested mailbox view/);
  } finally { console.warn = originalWarn; }
  assert.match(diagnostic, /OTHER_NETWORK_ERROR/);
  assert.doesNotMatch(diagnostic, /private-message-body|private-mailbox-name|ERR_PRIVATE_MESSAGE_BODY/, 'diagnostics cannot log browser error contents or arbitrary error names');
  assert.equal(readVerificationEmailsLocally(messages.map(verificationMessage), { hint: 'Fixture', want: 'code' })?.value, '482913');
  messageBody = '<p>Your Fixture one-time pass code:</p><div><span>482</span><span>913</span></div><p>Code: This code will expire in 10 minutes.</p>';
  const structured = await client.thread(threads[0].id);
  assert.match(structured[0].plaintextBody!, /482913\s+Code:/, 'rendered block boundaries must not append the next word to a private code');
  assert.equal(readVerificationEmailsLocally(structured.map(verificationMessage), { hint: 'Fixture', want: 'code' })?.value, '482913');
  await assert.rejects(client.thread('foreignthread'), /Search this mailbox/);
  for (const draft of drafts.values()) await client.sendApproved(draft.id, draft.revision);
  assert.equal(sends, 5); assert.equal(receipts.size, 5);
  const first = drafts.values().next().value!;
  assert.equal((await client.sendApproved(first.id, first.revision)).alreadySent, true); assert.equal(sends, 5);
  wrongAccount = true; await assert.rejects(client.search('verification'), /authorization|Reconnect/); wrongAccount = false;
  confirmed = false;
  await assert.rejects(withGmailBrowser('browser-owner', page => sendBrowserApplication(page, first, 'candidate@fixture.invalid', Buffer.from('CV'), 'CV.txt')), /did not confirm/);
  stop(); await assert.rejects(client.search('verification'), /authorization|Reconnect/);
  assert.equal(uploads, 0, 'file input receives server-owned approved bytes without an external file picker');
  console.log('PASS: Gmail empty-result wording, chronological searches without stale rows, failed-sort refusal, five browser-backed email applications over real MCP, exact approved letters and attachments, local code parsing, repeat receipts, wrong-account denial, uncertain sends and revoked browser routes; no real Gmail or employer email.');
} finally { stop(); lease.revoke(); await client.close(); await gateway.close(); await context.close(); rmSync(directory, { recursive: true, force: true }); }
