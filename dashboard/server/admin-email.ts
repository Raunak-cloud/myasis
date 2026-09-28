import { Resend } from 'resend';
import { one, query } from './db/index.js';
import { alertsEnabled } from './alerts.js';
import { billingStatus, isAdmin } from './billing.js';
import { digestConfig } from './digest.js';
import { profileGaps } from './profile.js';
import { readEnv } from './runner.js';
import { setupStatus } from './setup.js';

/**
 * A personal email from an operator to one account, drafted from where that
 * account actually stands.
 *
 * The automatic setup reminder (alerts.ts) sends once and is generic. This is
 * the follow-up a person writes: it names only the steps this account still
 * has, says what finishing gets them, and asks them to reply if they are
 * stuck — the pattern onboarding research finds works for stalled sign-ups.
 * The draft is a starting point; the operator edits it before it goes.
 *
 * Replies go to the support inbox, not the no-reply sender, and every send
 * is logged so two operators do not nudge the same person twice in a day.
 */

const SUPPORT_EMAIL_DEFAULT = 'support@owtomate.com';

function supportEmail(): string {
  return (process.env.SUPPORT_EMAIL ?? readEnv().SUPPORT_EMAIL ?? SUPPORT_EMAIL_DEFAULT).trim() || SUPPORT_EMAIL_DEFAULT;
}

interface Account { id: string; email: string; name: string | null }

export interface EmailDraft {
  to: string;
  replyTo: string;
  subject: string;
  body: string;
  /** Steps still open, as the account holder sees them. */
  missing: string[];
  /** They switched automatic emails off; a personal note may still be fine, but the operator should know. */
  optedOut: boolean;
  /** Mail can be sent from here; otherwise only the mail-app route works. */
  canSend: boolean;
  lastSent: { at: string; subject: string } | null;
}

const firstName = (name: string | null | undefined) => {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first ? `${first[0].toUpperCase()}${first.slice(1)}` : '';
};

/** What to do for each unfinished step, phrased as the action and why it matters. */
async function stepLines(userId: string, open: Array<{ id: string; label: string }>): Promise<string[]> {
  const lines: string[] = [];
  for (const check of open) {
    switch (check.id) {
      case 'resume':
        lines.push('Upload your résumé. Owtomate reads it and fills in your details and job titles for you.');
        break;
      case 'profile': {
        const gaps = await profileGaps(userId);
        lines.push(gaps.length ? `Check your details. Still missing: ${gaps.join(', ')}.` : 'Check your details.');
        break;
      }
      case 'looking':
        lines.push('Choose the job titles and city you want.');
        break;
      case 'boards':
        lines.push('Connect SEEK (or Indeed) so Owtomate can apply on your behalf.');
        break;
      default:
        lines.push(`${check.label}.`);
    }
  }
  return lines;
}

export async function draftSetupEmail(account: Account, sender: { name: string | null }): Promise<EmailDraft> {
  const config = digestConfig();
  const [status, billing, optedIn, last] = await Promise.all([
    setupStatus(account.id),
    billingStatus(account.id, account.email),
    alertsEnabled(account.id),
    one<{ sent_at: Date; subject: string }>('SELECT sent_at, subject FROM admin_emails WHERE user_id = $1 ORDER BY sent_at DESC LIMIT 1', [account.id]),
  ]);
  const open = status.checks.filter((check) => check.required && !check.done);
  const steps = await stepLines(account.id, open);
  const first = firstName(account.name);
  const link = `${(config?.dashboardUrl ?? 'https://owtomate.com').replace(/\/+$/, '')}/?tab=setup`;
  const free = isAdmin(account.email) ? 0 : billing.free.remaining;
  const signOff = firstName(sender.name);

  const subject = !open.length
    ? `${first ? `${first}, how` : 'How'} is Owtomate going?`
    : open.length === 1
      ? `${first ? `${first}, one` : 'One'} step left to start applying`
      : `${first ? `${first}, you're` : "You're"} ${open.length} steps from applying`;

  const opening = !open.length
    ? 'Your Owtomate setup is complete. I wanted to check everything is working the way you expected.'
    : status.done === 0
      ? 'Thanks for signing up to Owtomate. You are a few minutes away from having it apply to jobs for you.'
      : `Thanks for starting your Owtomate setup. You are nearly there, with ${open.length === 1 ? 'one step' : `${open.length} steps`} left:`;

  const body = [
    first ? `Hi ${first},` : 'Hi,',
    '',
    opening,
    ...(open.length
      ? [
        ...(status.done === 0 ? ['', "Here's what's left:"] : []),
        '',
        ...steps.map((line, index) => `${index + 1}. ${line}`),
        '',
        `Finish setup: ${link}`,
        '',
        `It takes about three minutes${free > 0 ? `, and your ${free} free applications are ready as soon as you're done` : ''}.`,
      ]
      : []),
    '',
    "If anything is confusing or not working, just reply to this email and I'll help.",
    '',
    signOff ? `${signOff}\nOwtomate` : 'The Owtomate team',
  ].join('\n');

  return {
    to: account.email,
    replyTo: supportEmail(),
    subject,
    body,
    missing: open.map((check) => check.label),
    optedOut: !optedIn,
    canSend: Boolean(config),
    lastSent: last ? { at: new Date(last.sent_at).toISOString(), subject: last.subject } : null,
  };
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The operator's plain text as email HTML: paragraphs kept, line breaks kept, web addresses clickable. */
export function renderPlainEmail(body: string): string {
  const paragraphs = body.trim().split(/\n\s*\n/).map((block) =>
    escape(block)
      .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}" style="color:#2f6fd0">${url}</a>`)
      .replace(/\n/g, '<br>'));
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#11141c;max-width:560px">
  ${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('\n  ')}
</div>`;
}

export const EMAIL_LIMITS = { subject: 200, body: 10_000 } as const;

export async function sendAdminEmail(account: Account, sender: { id: string }, subject: string, body: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const cleanSubject = subject.trim();
  const cleanBody = body.trim();
  if (!cleanSubject || cleanSubject.length > EMAIL_LIMITS.subject) return { ok: false, error: `Write a subject (up to ${EMAIL_LIMITS.subject} characters).`, status: 400 };
  if (!cleanBody || cleanBody.length > EMAIL_LIMITS.body) return { ok: false, error: `Write a message (up to ${EMAIL_LIMITS.body} characters).`, status: 400 };
  const config = digestConfig();
  if (!config) return { ok: false, error: 'Email is not configured: set RESEND_API_KEY and RESEND_FROM.', status: 503 };

  const result = await new Resend(config.apiKey).emails.send({
    from: config.from,
    to: account.email,
    replyTo: supportEmail(),
    subject: cleanSubject,
    text: cleanBody,
    html: renderPlainEmail(cleanBody),
  });
  if (result.error) return { ok: false, error: `The email was not sent: ${result.error.message}`, status: 502 };

  await query('INSERT INTO admin_emails (user_id, sent_by, subject, body) VALUES ($1, $2, $3, $4)', [account.id, sender.id, cleanSubject, cleanBody]);
  return { ok: true };
}
