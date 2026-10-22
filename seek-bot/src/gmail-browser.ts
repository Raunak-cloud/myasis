/// <reference lib="dom" />
import { chromium, type Browser, type Page } from 'patchright';
import type { GmailMessage, GmailThread } from './gmail-mcp-client.js';
import { GmailServiceError } from './gmail-mcp-service.js';
import type { PreparedApplication } from './application-review-types.js';

const routes = new Map<string, { port: number; account: string; active: boolean; browser?: Promise<Browser>; tail: Promise<unknown>; pages: Set<Page> }>();
export function registerGmailBrowser(userId: string, port: number, account: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid private Gmail browser port.');
  const route = { port, account, active: true, tail: Promise.resolve(), pages: new Set<Page>() };
  routes.set(userId, route);
  return () => { route.active = false; for (const page of route.pages) void page.close().catch(() => {}); if (routes.get(userId) === route) routes.delete(userId); };
}
export async function withGmailBrowser<T>(userId: string, action: (page: Page) => Promise<T>): Promise<T> {
  const route = routes.get(userId);
  if (!route?.active) throw new GmailServiceError('reconnect', 'Start a run with your connected Gmail browser.');
  const work = route.tail.catch(() => {}).then(async () => {
    if (!route.active) throw new GmailServiceError('reconnect', 'The Gmail browser session ended.');
    route.browser ??= chromium.connectOverCDP(`http://127.0.0.1:${route.port}`, { timeout: 15_000 });
    const browser = await route.browser;
    const context = browser.contexts()[0];
    if (!context) throw new GmailServiceError('reconnect', 'The Gmail browser is unavailable.');
    const page = await context.newPage();
    route.pages.add(page);
    try {
      await page.goto(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(route.account)}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.locator('[role="main"]').waitFor({ timeout: 15_000 }).catch(() => { throw new GmailServiceError('reconnect', 'Sign in to Gmail in Settings. The mailbox did not open.'); });
      const labels = await page.locator('a[aria-label^="Google Account:"], button[aria-label^="Google Account:"]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).getAttribute('aria-label') || '').join('\n'));
      const displayed = labels.match(/[^\s()<>]+@[^\s()<>]+/g) || [];
      if (!displayed.some(email => email.toLowerCase() === route.account.toLowerCase())) throw new GmailServiceError('reconnect', 'Gmail opened a different account. Connect the address in your profile.');
      return await action(page);
    } finally { route.pages.delete(page); await page.close().catch(() => {}); }
  });
  route.tail = work;
  return work.catch(error => {
    if (error instanceof GmailServiceError) throw error;
    throw new GmailServiceError('reconnect', 'The Gmail browser could not open. Reconnect browser Gmail in Settings and retry.');
  });
}
export async function searchBrowserGmail(userId: string, query: string): Promise<GmailThread[]> {
  return withGmailBrowser(userId, async page => {
    const base = page.url().split('#')[0];
    await page.goto(`${base}#search/${encodeURIComponent(`newer_than:2h -in:sent -in:draft (${query})`)}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForFunction(() => {
      const main = document.querySelector('[role="main"]');
      return main && /search results|no conversations found|no results found/i.test(main.textContent || '');
    }, undefined, { timeout: 15_000 });
    return page.locator('tr[role="row"][data-thread-id], tr[role="row"] [data-legacy-thread-id]').evaluateAll(nodes => [...new Set(nodes.map(node => (node as HTMLElement).getAttribute('data-thread-id') || (node as HTMLElement).getAttribute('data-legacy-thread-id') || '').filter(id => /^[\w-]{1,100}$/.test(id)))].slice(0, 20).map(id => ({ id })));
  });
}
export async function readBrowserGmail(userId: string, threadId: string): Promise<GmailMessage[]> {
  if (!/^[\w-]{1,100}$/.test(threadId)) throw new GmailServiceError('unapproved', 'Invalid Gmail thread.');
  return withGmailBrowser(userId, async page => {
    await page.goto(`${page.url().split('#')[0]}#all/${threadId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.locator('[role="main"] h2').first().waitFor({ timeout: 10_000 });
    return page.locator('[role="main"]').evaluate((main, id) => {
      const subject = (main as HTMLElement).querySelector('h2')?.textContent || '';
      return [...(main as HTMLElement).querySelectorAll('[data-message-id]')].map((node, index) => ({ id: `${id}_${index}`, subject,
        sender: node.querySelector('[email]')?.getAttribute('email') || '',
        date: new Date().toISOString(), plaintextBody: (node.querySelector('.a3s')?.textContent || '').slice(0, 12000),
        htmlBody: node.querySelector('.a3s')?.innerHTML.slice(0, 80000) || '' })).slice(-1);
    }, threadId);
  });
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
