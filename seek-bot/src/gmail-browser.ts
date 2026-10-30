/// <reference lib="dom" />
import { chromium, type Browser, type Page } from 'patchright';
import type { GmailMessage, GmailThread } from './gmail-mcp-client.js';
import { GmailServiceError } from './gmail-mcp-service.js';
import type { PreparedApplication } from './application-review-types.js';

const routes = new Map<string, { port: number; account: string; active: boolean; browser?: Promise<Browser>; tail: Promise<unknown>; pages: Set<Page> }>();
const THREAD_ROWS = 'tr[data-thread-id], tr[data-legacy-thread-id], tr [data-legacy-thread-id], tr [data-thread-id]';
const ERROR_NAMES = new Set(['Error', 'TimeoutError', 'TargetClosedError', 'ProtocolError', 'TypeError', 'ReferenceError', 'SyntaxError']);
const NETWORK_ERRORS = new Set(['ERR_FAILED', 'ERR_ABORTED', 'ERR_TIMED_OUT', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_TOO_MANY_REDIRECTS', 'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID']);
export function registerGmailBrowser(userId: string, port: number, account: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid private Gmail browser port.');
  const route = { port, account, active: true, tail: Promise.resolve(), pages: new Set<Page>() };
  routes.set(userId, route);
  return () => { route.active = false; for (const page of route.pages) void page.close().catch(() => {}); if (routes.get(userId) === route) routes.delete(userId); };
}
export async function withGmailBrowser<T>(userId: string, action: (page: Page) => Promise<T>, fragment = ''): Promise<T> {
  const route = routes.get(userId);
  if (!route?.active) throw new GmailServiceError('reconnect', 'Start a run with your connected Gmail browser.');
  let phase = 'connecting to the private browser';
  let connection: Browser | undefined;
  const work = route.tail.catch(() => {}).then(async () => {
    if (!route.active) throw new GmailServiceError('reconnect', 'The Gmail browser session ended.');
    if (!route.browser) {
      const connecting = chromium.connectOverCDP(`http://127.0.0.1:${route.port}`, { timeout: 15_000 }).then(browser => {
        browser.once('disconnected', () => { if (route.browser === connecting) route.browser = undefined; });
        return browser;
      }).catch(() => {
        if (route.browser === connecting) route.browser = undefined;
        throw new GmailServiceError('unavailable', 'The private Gmail browser connection is unavailable. Retry the mailbox request.');
      });
      route.browser = connecting;
    }
    const browser = await route.browser;
    connection = browser;
    const context = browser.contexts()[0];
    if (!browser.isConnected() || !context) {
      route.browser = undefined;
      throw new GmailServiceError('unavailable', 'The private Gmail browser session is unavailable. Retry the mailbox request.');
    }
    phase = 'opening a mailbox tab';
    const page = await context.newPage();
    route.pages.add(page);
    try {
      // Open the requested view from a new page. A later hash-only navigation
      // can otherwise read the previous inbox while Gmail renders the search.
      phase = 'opening Gmail';
      await page.goto(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(route.account)}${fragment}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      phase = 'waiting for the mailbox';
      await page.locator('[role="main"]').waitFor({ timeout: 15_000 }).catch(() => { throw new GmailServiceError('reconnect', 'Sign in to Gmail in Settings. The mailbox did not open.'); });
      phase = 'checking the signed-in account';
      const labels = await page.locator('a[aria-label^="Google Account:"], button[aria-label^="Google Account:"]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).getAttribute('aria-label') || '').join('\n'));
      const displayed = labels.match(/[^\s()<>]+@[^\s()<>]+/g) || [];
      if (!displayed.some(email => email.toLowerCase() === route.account.toLowerCase())) throw new GmailServiceError('reconnect', 'Gmail opened a different account. Connect the address in your profile.');
      phase = 'reading the requested mailbox view';
      return await action(page);
    } finally { route.pages.delete(page); await page.close().catch(() => {}); }
  });
  route.tail = work;
  return work.catch(error => {
    if (error instanceof GmailServiceError) throw error;
    const closed = !connection?.isConnected() || /Target closed|Target page, context or browser has been closed|Session closed|has been disconnected/i.test(String((error as Error)?.message));
    if (closed) {
      route.browser = undefined;
      void connection?.close().catch(() => {});
    }
    // Never log browser error text: it can contain mailbox URLs or message
    // contents. These bounded fields identify the failing operation instead.
    const errorName = error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : 'Error';
    const networkCode = /\bnet::(ERR_[A-Z_]+)/.exec(String((error as Error)?.message))?.[1];
    console.warn('[gmail-browser]', JSON.stringify({ userId, phase, error: errorName, closed,
      networkCode: networkCode ? NETWORK_ERRORS.has(networkCode) ? networkCode : 'OTHER_NETWORK_ERROR' : undefined }));
    throw new GmailServiceError('unavailable', `The Gmail browser request could not finish while ${phase}. Retry the mailbox request; this does not establish that Gmail is disconnected.`);
  });
}
async function waitForSearchResults(page: Page): Promise<void> {
  await page.waitForFunction(selector => {
    const main = document.querySelector('[role="main"]');
    return main && (main.querySelector(selector)
      || /no conversations found|no results found|no conversations match|no messages matched your search/i.test((main as HTMLElement).innerText || ''));
  }, THREAD_ROWS, { timeout: 15_000 }).catch(() => {
    throw new GmailServiceError('unavailable', 'Gmail opened, but the requested message list did not finish loading. Retry reading the mailbox; do not resend the verification email to repair this.');
  });
}
export async function searchBrowserGmail(userId: string, query: string): Promise<GmailThread[]> {
  return withGmailBrowser(userId, async page => {
    await waitForSearchResults(page);
    // Gmail can rank search results by relevance. Verification parsing needs
    // newest first, including when a mailbox has received replacement codes.
    const relevant = page.getByRole('button', { name: /^Showing most relevant$/i });
    if (await relevant.isVisible()) {
      await relevant.click({ timeout: 5_000 });
      await page.getByRole('menuitemradio', { name: /^Most recent\b/i }).click({ timeout: 5_000 });
      await page.getByRole('button', { name: /^Showing most recent$/i }).waitFor({ timeout: 5_000 });
      // The label can update before the list. A fresh load discards the old
      // relevance-ranked rows and retains Gmail's saved chronological choice.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByRole('button', { name: /^Showing most recent$/i }).waitFor({ timeout: 15_000 });
      await waitForSearchResults(page);
    }
    return page.locator(`[role="main"] :is(${THREAD_ROWS})`).evaluateAll(nodes => [...new Set(nodes.map(node =>
      [node.getAttribute('data-legacy-thread-id'), node.getAttribute('data-thread-id')]
        .find(id => id && /^[\w-]{1,100}$/.test(id)) || '').filter(Boolean))].slice(0, 20).map(id => ({ id })));
  }, `#search/${encodeURIComponent(`newer_than:2h -in:sent -in:draft (${query})`)}`);
}
export async function readBrowserGmail(userId: string, threadId: string): Promise<GmailMessage[]> {
  if (!/^[\w-]{1,100}$/.test(threadId)) throw new GmailServiceError('unapproved', 'Invalid Gmail thread.');
  return withGmailBrowser(userId, async page => {
    await page.locator('[role="main"] h2').first().waitFor({ timeout: 10_000 });
    await page.locator('[role="main"] [data-message-id] .a3s').first().waitFor({ state: 'attached', timeout: 10_000 });
    return page.locator('[role="main"]').evaluate((main, id) => {
      const subject = (main as HTMLElement).querySelector('h2')?.textContent || '';
      return [...(main as HTMLElement).querySelectorAll('[data-message-id]')].map((node, index) => ({ id: `${id}_${index}`, subject,
        sender: node.querySelector('[email]')?.getAttribute('email') || '',
        plaintextBody: (node.querySelector('.a3s')?.textContent || '').slice(0, 12000),
        htmlBody: node.querySelector('.a3s')?.innerHTML.slice(0, 80000) || '' })).slice(-1);
    }, threadId);
  }, `#all/${threadId}`);
}
export async function sendBrowserApplication(page: Page, draft: PreparedApplication, account: string, resume: Buffer, filename: string): Promise<{ id: string }> {
  const letter = draft.coverLetter;
  if (!draft.email || !letter || !account) throw new GmailServiceError('unapproved', 'No approved email.');
  let pressed = false;
  try {
    await page.getByRole('button', { name: 'Compose', exact: true }).click({ timeout: 8000 });
    const dialog = page.getByRole('dialog').last();
    const from = dialog.locator('input[name="from"]');
    if (await from.count() && (await from.inputValue()).toLowerCase() !== account.toLowerCase()) throw new GmailServiceError('unapproved', 'Gmail selected a different sending address.');
    const recipient = dialog.locator('input[peoplekit-id], input[name="to"], input[aria-label="To recipients"]').first();
    await recipient.fill(draft.email.to); await recipient.press('Enter');
    await dialog.locator('input[name="subjectbox"]').fill(draft.email.subject);
    const body = dialog.locator('[role="textbox"][contenteditable="true"]').first();
    await body.fill(letter);
    const files = [{ name: filename, mimeType: 'application/octet-stream', buffer: resume },
      ...(draft.email.attachCoverLetter ? [{ name: 'Cover letter.txt', mimeType: 'text/plain', buffer: Buffer.from(letter) }] : [])];
    // Gmail's native file input uploads the exact server-validated approved bytes.
    await dialog.locator('input[type="file"]').setInputFiles(files, { timeout: 10000 });
    for (const file of files) await dialog.getByText(file.name, { exact: false }).first().waitFor({ timeout: 20000 });
    await dialog.locator('[role="progressbar"]').waitFor({ state: 'hidden', timeout: 30000 });
    const paragraphs = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if ((await dialog.locator('input[name="subjectbox"]').inputValue()) !== draft.email.subject
      || paragraphs(await body.innerText()) !== paragraphs(letter)) throw new GmailServiceError('unapproved', 'The Gmail draft differs from the approved application.');
    const recipients = await dialog.locator('[email], [data-hovercard-id]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).getAttribute('email') || (node as HTMLElement).getAttribute('data-hovercard-id')).filter(Boolean));
    if (!recipients.length || recipients.some(email => email?.toLowerCase() !== draft.email!.to.toLowerCase())) throw new GmailServiceError('unapproved', 'The Gmail recipient differs from the approved application.');
    // Never accept a queued/scheduled email as a confirmed submission.
    const send = dialog.getByRole('button', { name: /^Send(?: \(|$)/ }).first();
    pressed = true; await send.click({ timeout: 10000 });
    await page.locator('[role="alert"], [role="status"]').filter({ hasText: /\bMessage sent\b/ }).first().waitFor({ timeout: 15000 });
    return { id: `browser_${draft.id}_${draft.revision.slice(0, 12)}` };
  } catch (error) {
    if (pressed) throw new GmailServiceError('uncertain', 'Gmail did not confirm sending. Check Sent before retrying.');
    if (error instanceof GmailServiceError) throw error;
    throw new GmailServiceError('reconnect', 'The Gmail form could not be completed. Reconnect browser Gmail and retry.');
  }
}
