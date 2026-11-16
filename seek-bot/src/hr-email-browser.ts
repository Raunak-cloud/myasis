import type { Locator, Page } from 'patchright';
import { createHash } from 'node:crypto';
import { validApplicationEmail } from './application-email-message.js';
import { GmailServiceError } from './gmail-mcp-service.js';
import { withGmailBrowser, searchBrowserGmail, readBrowserGmail } from './gmail-browser.js';
import { assertBrowserOperationActive } from './browser-deadline.js';
export type HrBrowserPage = Page;

export interface BrowserHrMail { id: string; to: string; subject: string; body: string; createdAt: string }
export const hrMailReference = (id: string) => `HR-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
export const hrMailBody = (mail: BrowserHrMail) => mail.body.trim().endsWith(`Application reference: ${hrMailReference(mail.id)}`)
  ? mail.body.trim() : `${mail.body.trim()}\n\nApplication reference: ${hrMailReference(mail.id)}`;

export function validateHrMail(mail: BrowserHrMail): void {
  if (!mail.id || mail.id.length > 150 || !validApplicationEmail(mail.to) || !mail.subject.trim()
    || /[\r\n\x00-\x1f\x7f]/.test(mail.subject) || Buffer.byteLength(mail.subject) > 300
    || !mail.body.trim() || mail.body.length > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(mail.body)
    || !Number.isFinite(Date.parse(mail.createdAt))) throw new GmailServiceError('unapproved', 'The HR email is incomplete.');
}

export async function sendBrowserHrEmail(page: Page, mail: BrowserHrMail, account: string): Promise<{ id: string }> {
  validateHrMail(mail);
  if (!validApplicationEmail(account)) throw new GmailServiceError('reconnect', 'Connect your profile Gmail address.');
  try {
    assertBrowserOperationActive();
    await page.getByRole('button', { name: 'Compose', exact: true }).click({ timeout: 8000 });
    const dialog = page.getByRole('dialog').last(), from = dialog.locator('input[name="from"]');
    if (await from.count() && (await from.inputValue()).toLowerCase() !== account.toLowerCase()) throw new GmailServiceError('unapproved', 'Gmail selected a different sending address.');
    const recipient = dialog.locator('input[peoplekit-id], input[name="to"], input[aria-label="To recipients"]').first();
    await recipient.fill(mail.to); await recipient.press('Enter');
    const subject = dialog.locator('input[name="subjectbox"]'), body = dialog.locator('[role="textbox"][contenteditable="true"]').first();
    await subject.fill(mail.subject); await body.fill(hrMailBody(mail));
    return await sendHrDraft(page, mail, account, dialog);
  } catch (error) {
    if (error instanceof GmailServiceError) throw error;
    throw new GmailServiceError('reconnect', 'The Gmail draft could not be completed. Reconnect browser Gmail.');
  }
}

/** Dispatch an already-open exact draft without creating another one. The caller
 * owns its durable send claim and must reconcile Sent before resuming a draft. */
export async function sendExistingBrowserHrDraft(page: Page, mail: BrowserHrMail, account: string): Promise<{ id: string }> {
  return sendHrDraft(page, mail, account);
}

async function sendHrDraft(page: Page, mail: BrowserHrMail, account: string, knownDraft?: Locator): Promise<{ id: string }> {
  validateHrMail(mail);
  if (!validApplicationEmail(account)) throw new GmailServiceError('reconnect', 'Connect your profile Gmail address.');
  let pressed = false;
  try {
    assertBrowserOperationActive();
    // Full-page Gmail drafts have neither role=dialog nor role=main. Wait for
    // their editor to load before checking that exactly one draft is open.
    const scope = knownDraft ?? page;
    const subjects = scope.locator('input[name="subjectbox"]:visible');
    await subjects.first().waitFor({ state: 'visible', timeout: 10000 });
    await scope.locator('[role="textbox"][contenteditable="true"]:visible').first().waitFor({ state: 'visible', timeout: 10000 });
    if (await subjects.count() !== 1) throw new GmailServiceError('unapproved', 'Gmail has more than one open draft.');
    const subject = subjects.first();
    const ancestor = subject.locator('xpath=ancestor::*[@role="dialog"][1]');
    const draft = knownDraft ?? (await ancestor.count() ? ancestor : page.locator('body'));
    const bodies = draft.locator('[role="textbox"][contenteditable="true"]:visible');
    if (await bodies.count() !== 1) throw new GmailServiceError('unapproved', 'The Gmail draft editor is ambiguous.');
    const body = bodies.first(), from = draft.locator('input[name="from"]');
    const fromValues = await from.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value.toLowerCase()));
    const labels = await page.locator('a[aria-label^="Google Account:"], button[aria-label^="Google Account:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') || '').join('\n'));
    const accounts = labels.match(/[^\s()<>]+@[^\s()<>]+/g) || [];
    if (fromValues.some(value => value !== account.toLowerCase()) || (accounts.length && !accounts.some(value => value.toLowerCase() === account.toLowerCase()))
      || (!fromValues.length && !accounts.length)) throw new GmailServiceError('unapproved', 'Gmail selected a different sending address.');
    const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (await subject.inputValue() !== mail.subject || normalize(await body.innerText()) !== normalize(hrMailBody(mail))) throw new GmailServiceError('unapproved', 'The Gmail draft differs from the HR email.');
    const recipients = await draft.locator('[email], [data-hovercard-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('email') || node.getAttribute('data-hovercard-id')).filter(Boolean));
    if (!recipients.length || recipients.some(email => email?.toLowerCase() !== mail.to.toLowerCase())) throw new GmailServiceError('unapproved', 'The Gmail recipient differs from the HR contact.');
    assertBrowserOperationActive();
    // Gmail wraps keyboard shortcuts in invisible direction marks. Match only
    // the primary Send control, excluding Send options and Schedule send.
    const send = draft.getByRole('button', { name: /^Send(?:\s|\p{Cf})*(?:\([^)]*\)(?:\s|\p{Cf})*)?$/u }).first();
    // A missing/unusable button has not attempted delivery. Only arm uncertain
    // send handling after Playwright confirms this exact control is actionable.
    await send.click({ trial: true, timeout: 10000 });
    assertBrowserOperationActive();
    pressed = true;
    await send.click({ timeout: 10000 });
    await page.locator('[role="alert"], [role="status"]').filter({ hasText: /\bMessage sent\b/ }).first().waitFor({ timeout: 15000 });
    return { id: `browser_${hrMailReference(mail.id)}` };
  } catch (error) {
    if (pressed) throw new GmailServiceError('uncertain', 'Gmail did not confirm the HR email. Check Sent before retrying.');
    if (error instanceof GmailServiceError) throw error;
    throw new GmailServiceError('reconnect', 'The Gmail draft could not be completed. Reconnect browser Gmail.');
  }
}

export async function sendHrMailInBrowser(userId: string, mail: BrowserHrMail, account: string) {
  return withGmailBrowser(userId, page => sendBrowserHrEmail(page, mail, account));
}

export async function openHrGmail(page: Page, account: string, fragment = ''): Promise<void> {
  assertBrowserOperationActive();
  if (!validApplicationEmail(account)) throw new GmailServiceError('reconnect', 'Connect your profile Gmail address.');
  // A hash-only transition can still display the previous mailbox view while
  // Gmail rerenders. This is our own tab, so require a fresh document instead.
  await page.goto('about:blank', { waitUntil: 'commit', timeout: 30000 });
  await page.goto(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}${fragment}`, { waitUntil: 'commit', timeout: 30000 });
  await page.locator('[role="main"]').waitFor({ timeout: 30000 });
  const labels = await page.locator('a[aria-label^="Google Account:"], button[aria-label^="Google Account:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') || '').join('\n'));
  const accounts = labels.match(/[^\s()<>]+@[^\s()<>]+/g) || [];
  if (!accounts.some(value => value.toLowerCase() === account.toLowerCase())) throw new GmailServiceError('reconnect', 'Gmail opened a different account. Connect your profile address.');
}

export async function reconcileHrEmailOnPage(page: Page, mail: BrowserHrMail, account: string): Promise<{ id: string; threadId: string } | null> {
  validateHrMail(mail);
  const after = Math.floor((Date.parse(mail.createdAt) - 5 * 60_000) / 1000);
  await openHrGmail(page, account, `#search/${encodeURIComponent(`in:sent to:${mail.to} after:${after} "${hrMailReference(mail.id)}"`)}`);
  const ready = await page.waitForFunction(() => {
    const main = document.querySelector('[role="main"]');
    if (!main) return false;
    const ids = [...new Set([...main.querySelectorAll('[data-thread-id], [data-legacy-thread-id]')]
      .map(node => node.getAttribute('data-legacy-thread-id') || node.getAttribute('data-thread-id')).filter(id => id && /^[\w-]{1,100}$/.test(id)))];
    return ids.length ? ids.slice(0, 10) : /no conversations found|no results found|no conversations match|no messages matched your search/i.test((main as HTMLElement).innerText || '') ? [] : false;
  }, undefined, { timeout: 30000 });
  let ids: string[];
  try { ids = await ready.jsonValue() as string[]; } finally { await ready.dispose(); }
  const normalize = (value: string) => value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  for (const id of ids) {
    await openHrGmail(page, account, `#all/${id}`);
    await page.locator('[role="main"] [data-message-id] .a3s').first().waitFor({ state: 'attached', timeout: 30000 });
    const content = await page.locator('[role="main"]').evaluate(main => ({ subject: main.querySelector('h2')?.textContent || '',
      messages: [...main.querySelectorAll('[data-message-id]')].map(node => ({ sender: node.querySelector('[email]')?.getAttribute('email') || '', body: (node.querySelector('.a3s') as HTMLElement | null)?.innerText || '' })) }));
    if (content.subject === mail.subject && content.messages.some(message => message.sender.toLowerCase() === account.toLowerCase() && normalize(message.body) === normalize(hrMailBody(mail)))) return { id: `browser_${hrMailReference(mail.id)}`, threadId: id };
  }
  return null;
}

/** Matching a subject alone is insufficient. The exact unique reference, body,
 * sender and Sent-folder search must all match before a lost receipt is repaired. */
export async function reconcileBrowserHrEmail(userId: string, mail: BrowserHrMail, account: string): Promise<{ id: string; threadId: string } | null> {
  validateHrMail(mail);
  const after = Math.floor((Date.parse(mail.createdAt) - 5 * 60_000) / 1000);
  const threads = await searchBrowserGmail(userId, `in:sent to:${mail.to} after:${after} "${hrMailReference(mail.id)}"`);
  const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  for (const thread of threads.slice(0, 10)) {
    const messages = await readBrowserGmail(userId, thread.id);
    if (messages.some(message => (message.sender || '').toLowerCase() === account.toLowerCase() && message.subject === mail.subject
      && normalize(message.plaintextBody || '') === normalize(hrMailBody(mail)))) return { id: `browser_${hrMailReference(mail.id)}`, threadId: thread.id };
  }
  return null;
}
