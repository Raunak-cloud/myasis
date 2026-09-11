import type { BrowserContext, Page } from 'patchright';

/**
 * Reading one-time codes out of Gmail in the browser the run already drives.
 *
 * The alternative is the Gmail API, which needs the `gmail.readonly` scope —
 * a restricted scope Google will not grant a production app without a paid
 * third-party security assessment. That is a real cost and a months-long
 * process for the sake of copying six digits out of an email.
 *
 * So instead the candidate signs a dedicated Gmail account into the same
 * Chrome profile the run uses (see the dashboard's sign-in window), and this
 * reads the code from that session. No token, no scope, no verification, and
 * nothing here ever sees a password.
 *
 * It must be a dedicated account, not a real inbox: anything visible in that
 * browser is visible to the agent.
 */

/** Gmail's own search syntax, narrowed to things that plausibly carry a code. */
const SEARCH = 'newer_than:1h (code OR verification OR verify OR passcode OR OTP OR "one-time")';

const INBOX = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(SEARCH)}`;

/**
 * How often to reload while waiting. Long enough that Gmail can finish
 * rendering a message list between reloads, short enough that mail arriving
 * mid-wait is still noticed.
 */
const RELOAD_EVERY_MS = 20_000;

/**
 * Roughly how many lines Gmail's shell alone produces — sidebar, labels,
 * counts and filter chips, with no message rows. More than this means rows
 * actually rendered.
 */
const CHROME_ONLY_LINES = 30;

/** Set by the dashboard when the profile's Chrome has a Google account signed in. */
export function browserGmailAvailable(): boolean {
  return Boolean(process.env.GMAIL_BROWSER_ACCOUNT);
}

export function browserGmailAccount(): string {
  return process.env.GMAIL_BROWSER_ACCOUNT ?? '';
}

/**
 * Whether this page is Gmail proper rather than a sign-in wall.
 *
 * A session that has lapsed does not error — it quietly redirects to
 * accounts.google.com, and scraping that would silently return no code
 * forever. Telling the two apart is what turns that into a fixable message.
 */
async function state(page: Page): Promise<'mail' | 'signed-out' | 'loading'> {
  const url = page.url();
  if (/accounts\.google\.com|ServiceLogin|signin\/v\d/i.test(url)) return 'signed-out';
  const text = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')) as string;
  if (/sign in|use another account|forgot email/i.test(text.slice(0, 400))) return 'signed-out';
  // Gmail's chrome is present on every mailbox view, empty results included.
  if (/\b(Inbox|Primary|Compose|Search mail)\b/i.test(text)) return 'mail';
  return 'loading';
}

const KEYWORD = /(?:code|pin|passcode|otp|one[- ]time)/gi;

/** 1900–2099 as a bare four-digit run: a year, not a code. */
const looksLikeYear = (digits: string) => digits.length === 4 && /^(?:19|20)\d\d$/.test(digits);

/**
 * Pulls a one-time code out of one message-list row.
 *
 * A code always has to sit near the word "code" (or PIN/passcode/OTP). There
 * is deliberately no last-resort "any number here" branch: this reads whole
 * list rows, not the subject line of an email already known to be a code
 * email, and rows are full of salaries, reference numbers and years. A bare
 * number rule typed 95000 from "Salary range 95000 to 120000" into a
 * verification field, which is far worse than not finding a code at all —
 * a miss is recoverable, a wrong code is a failed application.
 */
export function extractCode(row: string): string | null {
  const text = row.replace(/\s+/g, ' ');

  for (const match of text.matchAll(KEYWORD)) {
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 60);

    // Digits following the keyword, skipping anything that reads as a year.
    for (const digits of after.matchAll(/\b(\d{4,8})\b/g)) {
      if (!looksLikeYear(digits[1])) return digits[1];
    }

    // Letter-and-digit codes are case-sensitive: an uppercase run carrying
    // at least one digit and one letter.
    const alnum = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8}\b/.exec(after);
    if (alnum) return alnum[0];
  }

  // The other order: "728104 is your one-time passcode".
  for (const before of text.matchAll(/\b(\d{4,8})\b(?=[^0-9]{0,40}(?:is your|verification|code|passcode))/gi)) {
    if (!looksLikeYear(before[1])) return before[1];
  }

  return null;
}

export interface BrowserCodeResult {
  code: string;
  subject: string;
}

/**
 * Polls the mailbox until a code shows up or the deadline passes.
 *
 * Reads rendered text rather than Gmail's DOM structure on purpose. The class
 * names in that UI are obfuscated and change without notice, so a selector
 * written today is a breakage waiting to happen; the text of a message list is
 * far more stable, and a verification code is nearly always in the subject or
 * the snippet — visible without opening anything.
 */
export async function findCodeInBrowser(
  context: BrowserContext,
  options: { hint?: string; timeoutMs?: number; log?: (message: string) => void } = {},
): Promise<BrowserCodeResult | { error: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  const log = options.log ?? (() => {});
  const hint = options.hint?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const page = await context.newPage();
  try {
    await page.goto(INBOX, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

    let seenMail = false;
    let seenRows = false;
    /**
     * Gmail is a heavy single-page app: the shell, sidebar and even the
     * "1-1 of 1" result count paint well before the message rows do. An
     * earlier version reloaded every three seconds, which restarted that
     * render each time — it never once got as far as a row, and reported "no
     * email arrived" against an inbox that plainly had one. So the page is
     * loaded once and left alone to finish, and only reloaded occasionally,
     * to pick up mail that landed after this started watching.
     */
    let nextReload = Date.now() + RELOAD_EVERY_MS;

    while (Date.now() < deadline) {
      const where = await state(page);
      if (where === 'signed-out') {
        return {
          error:
            'The Gmail account is signed out in this browser profile. Sign it in again from the dashboard, then re-run.',
        };
      }
      if (where === 'mail') {
        seenMail = true;
        const text = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')) as string;

        /**
         * A row's sender, subject and snippet each land on their own line, so
         * a code and the keyword introducing it stay together while separate
         * messages stay apart — which matters when several employers are
         * mid-flight and only one of the codes is the one being asked for.
         */
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        if (lines.length > CHROME_ONLY_LINES) seenRows = true;
        const ranked = hint ? [...lines].sort((a, b) => scoreFor(b, hint) - scoreFor(a, hint)) : lines;

        for (const line of ranked) {
          const code = extractCode(line);
          if (code) return { code, subject: line.slice(0, 120) };
        }
      }

      await page.waitForTimeout(2_000);
      if (Date.now() >= nextReload) {
        nextReload = Date.now() + RELOAD_EVERY_MS;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      }
    }

    if (!seenMail) return { error: 'Gmail did not finish loading in this browser profile.' };
    // Told apart deliberately: a mailbox whose rows never rendered is a
    // different problem from one that rendered and held no code, and only the
    // second means "the email has not arrived".
    if (!seenRows) return { error: 'Gmail loaded but never rendered its message list.' };
    return { error: 'No verification email arrived in Gmail within the wait.' };
  } finally {
    await page.close().catch(() => {});
    log('  ✉ closed the Gmail tab');
  }
}

/** Rows mentioning the employer come first; the rest still get looked at. */
function scoreFor(line: string, hint: string): number {
  const haystack = line.toLowerCase();
  return hint.split(' ').filter((word) => word.length > 2 && haystack.includes(word)).length;
}
