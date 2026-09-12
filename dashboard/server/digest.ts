import { Resend } from 'resend';
import { query } from './db/index.js';
import { readEnv } from './runner.js';
import { loadAttention } from './attention.js';
import { RUN_TIME_ZONE, AUTO_WINDOW } from './entitlements.js';

/**
 * The evening summary.
 *
 * A candidate whose applications go out on a schedule never watches them
 * happen, so once the window closes they get one email: what went out, what
 * stalled on a question only they can answer, and a link to the rest. It is
 * the only thing that turns a background service into something a person can
 * trust — silence all day and no account of it is indistinguishable from
 * nothing working.
 *
 * Deliberately not sent when the day was empty. An account that did nothing
 * gets no mail, because a daily "nothing happened" trains people to ignore
 * the ones that matter.
 */

/** Local midnight, expressed so Postgres compares against the candidate's day. */
const DAY_START = `(date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`;

export interface Digest {
  userId: string;
  email: string;
  name: string | null;
  runs: number;
  applications: Array<{ title: string; company: string; external: boolean }>;
  /** Jobs that stopped on something the candidate has to answer. */
  needsAnswer: number;
  /** Runs that ended without applying and without a question to ask. */
  failed: number;
}

export async function gatherDigest(userId: string, email: string, name: string | null): Promise<Digest> {
  const [runs, applications, events, attention] = await Promise.all([
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM run_starts WHERE user_id = $1 AND started_at >= ${DAY_START}`,
      [userId, RUN_TIME_ZONE],
    ),
    query<{ title: string; company: string; external: boolean }>(
      `SELECT title, company, external FROM applications
        WHERE user_id = $1 AND applied_at >= ${DAY_START}
        ORDER BY applied_at`,
      [userId, RUN_TIME_ZONE],
    ),
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM run_events
        WHERE user_id = $1 AND status = 'error' AND ts >= ${DAY_START}`,
      [userId, RUN_TIME_ZONE],
    ),
    loadAttention(userId).catch(() => []),
  ]);

  return {
    userId,
    email,
    name,
    runs: Number(runs[0]?.n ?? 0),
    applications,
    needsAnswer: attention.length,
    failed: Number(events[0]?.n ?? 0),
  };
}

/** Nothing to say means nothing to send. */
export function worthSending(digest: Digest): boolean {
  return digest.runs > 0 || digest.applications.length > 0 || digest.needsAnswer > 0;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function renderDigest(digest: Digest, dashboardUrl: string): { subject: string; text: string; html: string } {
  const sent = digest.applications.length;
  const subject = sent
    ? `${plural(sent, 'application')} sent today`
    : digest.needsAnswer
      ? `${plural(digest.needsAnswer, 'job')} need your answer`
      : 'Your Myasis summary';

  /** Names arrive however the account was created — "rinu" should not stay "rinu". */
  const firstName = (digest.name ?? '').trim().split(/\s+/)[0] ?? '';
  const greeting = firstName ? `Hi ${firstName[0].toUpperCase()}${firstName.slice(1)},` : 'Hi,';
  const lines = [
    greeting,
    '',
    sent
      ? `Myasis sent ${plural(sent, 'application')} for you today across ${plural(digest.runs, 'run')}:`
      : `Myasis made ${plural(digest.runs, 'run')} today and did not send any applications.`,
  ];

  for (const a of digest.applications) {
    lines.push(`  • ${a.title} — ${a.company}${a.external ? " (employer's own site)" : ''}`);
  }

  if (digest.needsAnswer) {
    lines.push('', `${plural(digest.needsAnswer, 'job')} stopped on a question only you can answer — things like a police check or years of experience. Answering once saves the answer for every later application.`);
  }
  if (digest.failed) {
    lines.push('', `${plural(digest.failed, 'run')} ran into a problem and stopped.`);
  }

  lines.push('', `See everything: ${dashboardUrl}`, '', '— Myasis');
  const text = lines.join('\n');

  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const items = digest.applications
    .map((a) => `<li style="margin:0 0 6px"><strong>${escape(a.title)}</strong> — ${escape(a.company)}${a.external ? ' <span style="color:#606b7d">(employer\'s own site)</span>' : ''}</li>`)
    .join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#11141c;max-width:520px">
  <p>${escape(greeting)}</p>
  <p>${
    sent
      ? `Myasis sent <strong>${plural(sent, 'application')}</strong> for you today across ${plural(digest.runs, 'run')}.`
      : `Myasis made ${plural(digest.runs, 'run')} today and did not send any applications.`
  }</p>
  ${items ? `<ul style="padding-left:18px;margin:0 0 16px">${items}</ul>` : ''}
  ${
    digest.needsAnswer
      ? `<p style="background:#f4f6f9;border-radius:8px;padding:12px 14px;margin:0 0 16px"><strong>${plural(digest.needsAnswer, 'job')} need your answer.</strong><br>They stopped on something only you can confirm — a police check, years of experience, a start date. Answering once saves it for every later application.</p>`
      : ''
  }
  ${digest.failed ? `<p>${plural(digest.failed, 'run')} ran into a problem and stopped.</p>` : ''}
  <p style="margin:22px 0"><a href="${escape(dashboardUrl)}" style="background:#2f6fd0;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;display:inline-block">Open your dashboard</a></p>
  <p style="color:#606b7d;font-size:13px">— Myasis</p>
</div>`;

  return { subject, text, html };
}

export interface DigestConfig {
  apiKey: string;
  from: string;
  dashboardUrl: string;
}

/** Null when the installation has not been given what it needs to send mail. */
export function digestConfig(): DigestConfig | null {
  const env = readEnv();
  const apiKey = (process.env.RESEND_API_KEY ?? env.RESEND_API_KEY ?? '').trim();
  const from = (process.env.RESEND_FROM ?? env.RESEND_FROM ?? '').trim();
  const dashboardUrl = (process.env.DASHBOARD_URL ?? env.DASHBOARD_URL ?? '').trim();
  if (!apiKey || !from) return null;
  return { apiKey, from, dashboardUrl: dashboardUrl || 'https://myasis.app' };
}

/**
 * Sends the day's summary to every account that had one.
 *
 * A row in `daily_digests` is claimed before the email goes out, so the
 * once-a-minute tick cannot send twice; the claim is released again if the
 * send fails, so a transient error retries rather than costing someone their
 * summary. Returns the addresses written to, for the log and for tests.
 */
export async function sendDailyDigests(now: Date = new Date()): Promise<string[]> {
  const config = digestConfig();
  if (!config) return [];

  const day = new Intl.DateTimeFormat('en-CA', { timeZone: RUN_TIME_ZONE }).format(now); // YYYY-MM-DD
  const users = await query<{ id: string; email: string; name: string | null }>(
    `SELECT u.id::text AS id, u.email, u.name
       FROM users u
       LEFT JOIN daily_digests d ON d.user_id = u.id AND d.day = $1::date
      WHERE d.user_id IS NULL`,
    [day],
  );
  if (!users.length) return [];

  const resend = new Resend(config.apiKey);
  const sent: string[] = [];

  for (const user of users) {
    let digest: Digest;
    try {
      digest = await gatherDigest(user.id, user.email, user.name);
    } catch {
      continue;
    }
    if (!worthSending(digest)) continue;

    // Claim the day before sending; a duplicate claim means another tick won.
    const claim = await query<{ user_id: string }>(
      `INSERT INTO daily_digests (user_id, day) VALUES ($1, $2::date)
       ON CONFLICT DO NOTHING RETURNING user_id::text AS user_id`,
      [user.id, day],
    );
    if (!claim.length) continue;

    const { subject, text, html } = renderDigest(digest, config.dashboardUrl);
    try {
      const result = await resend.emails.send({ from: config.from, to: user.email, subject, text, html });
      if (result.error) throw new Error(result.error.message);
      sent.push(user.email);
    } catch (error) {
      // Release the claim so the next tick tries again.
      await query('DELETE FROM daily_digests WHERE user_id = $1 AND day = $2::date', [user.id, day]).catch(() => {});
      console.warn(`[digest] ${user.email}: ${(error as Error).message}`);
    }
  }

  if (sent.length) console.log(`[digest] sent ${sent.length} summary email(s)`);
  return sent;
}

/** After the window shuts, and only for the rest of that evening. */
export function digestDue(at: Date = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: RUN_TIME_ZONE }).format(at));
  return hour >= AUTO_WINDOW.endHour;
}
