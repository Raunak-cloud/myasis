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
const gmailNavigations: string[] = [];
const letter = 'Dear team,\n\nThis is the exact approved cover letter.';
const pageHtml = () => `<!doctype html><a aria-label="Google Account: ${wrongAccount ? 'other' : 'candidate'}@fixture.invalid"></a><main role="main"><table><tr role="row"><td data-legacy-thread-id="fixturethread">Fixture code</td></tr></table><article data-message-id="message"><h2>Fixture verification</h2><span email="noreply@fixture.invalid"></span><div class="a3s">Your Fixture verification code: 482913</div></article></main><button onclick="document.querySelector('[role=dialog]').hidden=false">Compose</button><section role="dialog" hidden><input name="to" onkeydown="if(event.key==='Enter'){const p=document.createElement('span');p.setAttribute('email',this.value);this.parentElement.append(p)}"><input name="subjectbox"><div role="textbox" contenteditable="true"></div><input type="file" multiple onchange="for(const f of this.files){const p=document.createElement('span');p.textContent=f.name;this.parentElement.append(p)}"><button onclick="fetch('/fixture-send',{method:'POST'}).then(()=>{${confirmed ? 'document.body.insertAdjacentHTML(\'beforeend\',\'<p role=status>Message sent</p>\')' : ''}})">Send</button></section>`;
await context.route('**/*', route => {
  if (mailboxUnavailable) return route.abort();
  if (new URL(route.request().url()).pathname === '/fixture-send') { sends++; return route.fulfill({ body: '{}' }); }
  return route.fulfill({ contentType: 'text/html', body: emptySearch ? pageHtml().replace(/<table>.*?<\/table>/, '<p>No conversations found.</p>') : pageHtml() });
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
  assert.ok(gmailNavigations.some(url => url.includes('#search/')), 'search opens the requested view directly, without reading a stale inbox');
  emptySearch = true; assert.deepEqual(await client.search('no matching email'), []); emptySearch = false;
  mailboxUnavailable = true;
  await assert.rejects(client.search('verification'), /Gmail browser request could not finish/, 'navigation failures retain their real error rather than claiming authorization was revoked');
  mailboxUnavailable = false;
  assert.equal((await client.search('verification'))[0].id, 'fixturethread', 'a temporary mailbox failure does not poison later reads');
  const messages = await client.thread(threads[0].id);
  assert.equal(readVerificationEmailsLocally(messages.map(verificationMessage), { hint: 'Fixture', want: 'code' })?.value, '482913');
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
  console.log('PASS: five browser-backed email applications over real MCP, exact approved letters and attachments, local code parsing, repeat receipts, wrong-account denial, uncertain sends and revoked browser routes; no real Gmail or employer email.');
} finally { stop(); lease.revoke(); await client.close(); await gateway.close(); await context.close(); rmSync(directory, { recursive: true, force: true }); }
