import type { BrowserContext, Locator, Page } from 'patchright';
import { readVerificationEmails, type VerificationEmail } from './llm.js';

/**
 * Reading verification emails out of Gmail in the browser the run already drives.
 *
 * The alternative is the Gmail API, which needs the `gmail.readonly` scope —
 * a restricted scope Google will not grant a production app without a paid
 * third-party security assessment. That is a real cost and a months-long
 * process for the sake of one code or one link.
 *
 * So instead the candidate signs a dedicated Gmail account into the same
 * Chrome profile the run uses (see the dashboard's sign-in window), and this
 * reads from that session. No token, no scope, and nothing here ever sees a
 * password. It must be a dedicated account, not a real inbox: anything
 * visible in that browser is visible to the agent.
 *
 * What is in an email is read by the model, not by patterns. Codes live in
 * bodies as often as in subjects, arrive as "123 456" or "A7K-9QX", and many
 * sites (Workday among them) send a link instead of a code. The browser's job
 * is only to open the likeliest messages and hand over their text and links;
 * the model decides which message belongs to this site and what in it is the
 * credential, and every answer is checked against the message verbatim.
 */

/** Recent mail only, narrowed to things that plausibly verify an account. */
const SEARCH =
  'newer_than:2h (code OR verify OR verification OR confirm OR confirmation OR activate OR activation OR ' +
  'password OR passcode OR OTP OR "one-time" OR "sign in" OR login OR "log in" OR account)';
const INBOX = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(SEARCH)}`;

/** Gmail's shell renders long before the rows; reload rarely so a render can finish. */
const RELOAD_EVERY_MS = 20_000;
/** Messages opened per look. Newest and most site-relevant first. */
const OPEN_AT_MOST = 3;
/** Gmail's message-list rows: the accessible role first, the long-stable class as a fallback. */
const ROWS = '[role="main"] tr[role="row"], [role="main"] tr.zA';

/** Set by the dashboard when the profile's Chrome has a Google account signed in. */
export function browserGmailAvailable(): boolean {
  return Boolean(process.env.GMAIL_BROWSER_ACCOUNT);
}

export function browserGmailAccount(): string {
  return process.env.GMAIL_BROWSER_ACCOUNT ?? '';
}

/**
 * Every browser call here is bounded. A Gmail tab can stop answering (a stuck
 * reload, a navigation that never commits), and an unbounded evaluate then
 * waits forever — which once froze a whole run for twenty minutes.
 */
function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((done) => setTimeout(() => done(fallback), Math.max(0, ms))),
  ]);
}

async function state(page: Page): Promise<'mail' | 'signed-out' | 'loading'> {
  const url = page.url();
  if (/accounts\.google\.com|ServiceLogin|signin\/v\d/i.test(url)) return 'signed-out';
  const text = await bounded(page.evaluate(() => document.body?.innerText ?? ''), 5_000, '');
  if (/sign in|use another account|forgot email/i.test(text.slice(0, 400))) return 'signed-out';
  if (/\b(Inbox|Primary|Compose|Search mail)\b/i.test(text)) return 'mail';
  return 'loading';
}

/** Rows mentioning the sender hint first, otherwise newest first (Gmail's own order). */
function rank(rows: string[], hint: string): number[] {
  const words = hint.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((word) => word.length > 2);
  const score = (row: string) => words.filter((word) => row.toLowerCase().includes(word)).length;
  return rows.map((_, index) => index).sort((a, b) => score(rows[b]) - score(rows[a]) || a - b);
}

/** The opened message: its visible text and its links, with Gmail's redirect wrapper removed. */
async function readOpenMessage(page: Page): Promise<Omit<VerificationEmail, 'position'> | null> {
  return bounded(
    page.evaluate(() => {
      const main = document.querySelector('[role="main"]') as HTMLElement | null;
      if (!main) return null;
      const unwrap = (href: string) => {
        try {
          const url = new URL(href);
          if (/(^|\.)google\.com$/.test(url.hostname) && url.pathname === '/url') return url.searchParams.get('q') ?? href;
        } catch {}
        return href;
      };
      const links = [...main.querySelectorAll('a[href]')]
        .map((anchor) => ({
          text: ((anchor as HTMLElement).innerText || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          url: unwrap((anchor as HTMLAnchorElement).href),
        }))
        .filter((link) => /^https?:/i.test(link.url) && !/(^|\.)(google|gmail)\.com\//i.test(link.url.replace(/^https?:\/\//, '')));
      const subject = (document.querySelector('h2') as HTMLElement | null)?.innerText?.trim() ?? '';
      return { subject, text: main.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 6_000), links: links.slice(0, 40) };
    }),
    6_000,
    null,
  );
}

async function openRow(page: Page, row: Locator): Promise<boolean> {
  const before = page.url();
  if (!(await bounded(row.click({ timeout: 4_000 }).then(() => true), 5_000, false))) return false;
  await bounded(page.waitForURL((url) => url.toString() !== before, { timeout: 6_000 }), 7_000, undefined);
  await bounded(page.locator('[role="main"] [role="listitem"], [role="main"] h2').first().waitFor({ timeout: 6_000 }), 7_000, undefined);
  return page.url() !== before;
}

export interface VerificationResult {
  kind: 'code' | 'link';
  value: string;
  subject: string;
}

/**
 * Waits for a verification email from `hint`'s site and returns the code or
 * link it carries. `want` says what the page asked for; `either` lets the
 * model choose when the page did not say.
 */
export async function findVerificationInBrowser(
  context: BrowserContext,
  options: { hint?: string; site?: string; want?: 'code' | 'link' | 'either'; timeoutMs?: number; log?: (message: string) => void } = {},
): Promise<VerificationResult | { error: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const left = () => Math.max(0, deadline - Date.now());
  const log = options.log ?? (() => {});
  const hint = options.hint ?? '';
  const want = options.want ?? 'either';

  const page = await bounded(context.newPage(), 10_000, null);
  if (!page) return { error: 'Could not open a Gmail tab in this browser profile.' };
  try {
    await bounded(page.goto(INBOX, { waitUntil: 'domcontentloaded', timeout: 30_000 }), Math.min(left(), 32_000), null);
    let seenMail = false;
    let seenRows = false;
    const examined = new Set<string>();
    let nextReload = Date.now() + RELOAD_EVERY_MS;

    while (left() > 0) {
      const where = await state(page);
      if (where === 'signed-out') {
        return { error: 'The Gmail account is signed out in this browser profile. Sign it in again from the dashboard, then re-run.' };
      }
      if (where === 'mail') {
        seenMail = true;
        const rows = page.locator(ROWS);
        const texts = await bounded(rows.allInnerTexts(), 5_000, [] as string[]);
        if (texts.length) seenRows = true;
        const fresh = rank(texts, hint).filter((index) => !examined.has(texts[index])).slice(0, OPEN_AT_MOST);
        if (fresh.length) {
          const emails: VerificationEmail[] = [];
          for (const index of fresh) {
            if (left() < 8_000) break;
            examined.add(texts[index]);
            if (!(await openRow(page, rows.nth(index)))) continue;
            const message = await readOpenMessage(page);
            if (message) emails.push({ ...message, position: index });
            await bounded(page.goBack({ waitUntil: 'domcontentloaded', timeout: 8_000 }), 9_000, null);
            await bounded(page.locator(ROWS).first().waitFor({ timeout: 6_000 }), 7_000, undefined);
          }
          if (emails.length) {
            const found = await bounded(readVerificationEmails(emails, { site: options.site ?? '', hint, want }), Math.min(left(), 60_000), null);
            if (found) {
              log(`  ✉ read the ${found.kind} in "${found.subject.slice(0, 60)}"`);
              return found;
            }
          }
        }
      }
      await page.waitForTimeout(Math.min(2_000, left())).catch(() => {});
      if (Date.now() >= nextReload && left() > 5_000) {
        nextReload = Date.now() + RELOAD_EVERY_MS;
        // Mail that arrives while waiting only shows after a reload; revisit rows whose text changed.
        await bounded(page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }), Math.min(left(), 21_000), null);
      }
    }

    if (!seenMail) return { error: 'Gmail did not finish loading in this browser profile.' };
    if (!seenRows) return { error: 'No verification email arrived in Gmail within the wait.' };
    return { error: `No email in Gmail carried a ${want === 'either' ? 'code or link' : want} for this site within the wait.` };
  } finally {
    await bounded(page.close(), 5_000, undefined);
    log('  ✉ closed the Gmail tab');
  }
}

/** The code-only form, for callers that type a code (sign-in helpers). */
export async function findCodeInBrowser(
  context: BrowserContext,
  options: { hint?: string; timeoutMs?: number; log?: (message: string) => void } = {},
): Promise<{ code: string; subject: string } | { error: string }> {
  const found = await findVerificationInBrowser(context, { ...options, site: options.hint, want: 'code' });
  if ('error' in found) return found;
  return found.kind === 'code' ? { code: found.value, subject: found.subject } : { error: 'The email carried a link, not a code.' };
}
