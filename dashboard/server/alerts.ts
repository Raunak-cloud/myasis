import { createHmac, timingSafeEqual } from 'node:crypto';
import { Resend } from 'resend';
import { one, query } from './db/index.js';
import { upsertSettingRow } from './db/records.js';
import { billingStatus, isAdmin, type BillingStatus } from './billing.js';
import { digestConfig } from './digest.js';
import { entitlementsFor } from './entitlements.js';
import { readEnv } from './runner.js';
import { readSiteState } from './seek-state.js';
import { accountSetupChecks } from './setup.js';
import { PAID_PLANS } from '../src/pricing.js';

/**
 * Emails about the things that stop an account working.
 *
 * The evening summary says what happened today. These say that something has
 * stopped, or is about to, and only a person can fix it: the applications are
 * nearly gone or gone, a job board has signed the account out, runs keep
 * failing, a paid account cannot run because its setup was never finished.
 * Without them the first an account holder hears is silence — the service is
 * a background one, and silence is also what working looks like.
 *
 * Each alert is one entry below: when it applies, how long that must stay true
 * before anyone is told, and what the email says. The bookkeeping is the same
 * for all of them and lives in one place:
 *
 *  - an alert is sent once when its condition becomes true, never again while
 *    it stays true — a row in `account_alerts` is the memory of that;
 *  - when the condition stops being true the row is removed, so the next time
 *    is a new event and is told again;
 *  - the row is claimed before the email goes out and its claim released if
 *    the send fails, the same way the evening summary guards against the
 *    once-a-minute tick sending twice.
 *
 * A more serious alert silences a lesser one about the same thing: an account
 * that reaches zero is not also told it is running low.
 */

export interface Facts {
  billing: BillingStatus;
  /** Everything ever granted to the account that still counts, so "10% left" means 10% of what they had. */
  granted: number;
  signedOutBoards: string[];
  recentRuns: Array<{ failed: boolean; stopped: boolean }>;
  missingSetup: string[];
  hasAutoRuns: boolean;
}

interface Message {
  subject: string;
  /** Plain sentences; the first is the point. */
  paragraphs: string[];
  action: { label: string; tab: string };
}

interface AlertKind {
  key: string;
  /** Minutes the condition must hold before anyone is told. Rides out a blip: a board re-signed-in by the next check, a setup step finished an hour after paying. */
  holdMinutes: number;
  /** Alerts this one makes redundant while it is active. */
  silences?: string[];
  applies(facts: Facts): boolean;
  message(facts: Facts): Message;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const TOP_UP = PAID_PLANS['application-top-up'];

/** "Super low": a tenth of what the account was given, and never so early that it is just noise. */
function lowThreshold(facts: Facts): number {
  return facts.billing.paid.hasActivePass ? Math.max(5, Math.floor(facts.granted * 0.1)) : 1;
}

const ALERTS: AlertKind[] = [
  {
    key: 'applications-out',
    holdMinutes: 0,
    silences: ['applications-low'],
    applies: (facts) => facts.billing.totalRemaining < 1,
    message: () => ({
      subject: 'You are out of applications, so Owtomate has stopped applying',
      paragraphs: [
        'Your applications are used up, so Owtomate has stopped applying for you.',
        'Nothing is lost: your résumé, answers and search stay as they are, and applying picks up again as soon as you add more.',
      ],
      action: { label: 'See plans', tab: 'pricing' },
    }),
  },
  {
    key: 'applications-low',
    holdMinutes: 0,
    applies: (facts) => facts.billing.totalRemaining >= 1 && facts.billing.totalRemaining <= lowThreshold(facts),
    message: (facts) => ({
      subject: `${plural(facts.billing.totalRemaining, 'application')} left on Owtomate`,
      paragraphs: [
        `You have ${plural(facts.billing.totalRemaining, 'application')} left. When they are used, Owtomate stops applying until you add more.`,
        facts.billing.paid.hasActivePass
          ? `A top-up adds ${TOP_UP.applications} more and never expires.`
          : 'A pass adds more applications, more runs a day and Indeed, and never expires.',
      ],
      action: { label: facts.billing.paid.hasActivePass ? 'Add applications' : 'See plans', tab: 'pricing' },
    }),
  },
  {
    key: 'board-signed-out',
    // The next check or run tries to sign back in by itself; only a sign-out that survives that is worth an email.
    // Six hours spans at least one scheduled run on every plan, so the attempt the email mentions has really been made.
    holdMinutes: 6 * 60,
    applies: (facts) => facts.signedOutBoards.length > 0,
    message: (facts) => {
      const boards = facts.signedOutBoards.join(' and ');
      return {
        subject: `${boards} signed you out, so Owtomate cannot apply there`,
        paragraphs: [
          `${boards} has signed your account out. Owtomate tries to sign back in by itself, and that has not worked, so until you sign in again it cannot apply on ${boards}.`,
          'It takes a minute: open the Apply page and choose "Sign in again".',
        ],
        action: { label: 'Sign in again', tab: 'run' },
      };
    },
  },
  {
    key: 'runs-failing',
    holdMinutes: 0,
    // Three in a row, none of them ended by the person pressing Stop.
    applies: (facts) => facts.recentRuns.length >= 3 && facts.recentRuns.slice(0, 3).every((run) => run.failed && !run.stopped),
    message: () => ({
      subject: 'Your last 3 Owtomate runs failed',
      paragraphs: [
        'Your last 3 runs each stopped on a problem before sending any application.',
        'The Apply page shows what each run hit. If it is not something you can fix there, reply to this email and we will look into it.',
      ],
      action: { label: 'See what happened', tab: 'run' },
    }),
  },
  {
    key: 'setup-incomplete',
    // A day: most people finish setup in the sitting they start it in.
    holdMinutes: 24 * 60,
    applies: (facts) => facts.hasAutoRuns && facts.billing.totalRemaining > 0 && facts.missingSetup.length > 0,
    message: (facts) => ({
      subject: 'Owtomate cannot start applying until your setup is finished',
      paragraphs: [
        `Owtomate has not been able to apply for you yet, because your setup is missing: ${facts.missingSetup.join(', ').toLowerCase()}.`,
        'Once that is filled in, applying starts by itself at the next scheduled time.',
      ],
      action: { label: 'Finish setup', tab: 'setup' },
    }),
  },
];

/** The alerts that apply to an account in this state, the redundant ones already removed. Pure, so the rules can be tested without a database or a mailbox. */
export function alertsFor(facts: Facts): Array<{ key: string; holdMinutes: number; message: Message }> {
  const active = ALERTS.filter((alert) => alert.applies(facts));
  const silenced = new Set(active.flatMap((alert) => alert.silences ?? []));
  return active.filter((alert) => !silenced.has(alert.key)).map((alert) => ({ key: alert.key, holdMinutes: alert.holdMinutes, message: alert.message(facts) }));
}

// ---------------------------------------------------------------- facts

const BOARD_NAMES: Record<string, string> = { seek: 'SEEK', indeed: 'Indeed' };

async function gatherFacts(userId: string, email: string): Promise<Facts> {
  const [billing, entitlements, grants, runs, setup] = await Promise.all([
    billingStatus(userId, email),
    entitlementsFor(userId, email),
    one<{ total: string }>(
      `SELECT COALESCE(sum(credits_total), 0)::text AS total FROM application_credit_grants
        WHERE user_id = $1 AND credits_used < credits_total AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    ),
    query<{ exit_code: number | null; applied: number | null; stopped: boolean | null }>(
      `SELECT exit_code, applied, stopped FROM run_starts
        WHERE user_id = $1 AND mode = 'live' AND finished_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 3`,
      [userId],
    ),
    accountSetupChecks(userId),
  ]);

  // Indeed only matters to an account whose plan applies there.
  const boards = entitlements.indeedApplications ? ['seek', 'indeed'] : ['seek'];
  return {
    billing,
    granted: Number(grants?.total ?? 0) + billing.free.allowance,
    signedOutBoards: boards.filter((board) => readSiteState(userId, board as 'seek' | 'indeed')?.signedIn === false).map((board) => BOARD_NAMES[board]),
    recentRuns: runs.map((run) => ({ failed: (run.exit_code ?? 0) !== 0 && !run.applied, stopped: Boolean(run.stopped) })),
    missingSetup: Object.values(setup).filter((check) => check.required && !check.done).map((check) => check.label),
    hasAutoRuns: entitlements.autoRunsPerDay > 0 && !entitlements.autoApplyPaused,
  };
}

// ---------------------------------------------------------------- preference

const EMAIL_ALERTS_KEY = 'EMAIL_ALERTS';

/** On unless the account has switched them off. */
export async function alertsEnabled(userId: string): Promise<boolean> {
  const row = await one<{ value: string }>('SELECT value FROM settings WHERE user_id = $1 AND key = $2', [userId, EMAIL_ALERTS_KEY]);
  return row?.value !== 'off';
}

export async function setAlertsEnabled(userId: string, enabled: boolean): Promise<void> {
  await upsertSettingRow(userId, EMAIL_ALERTS_KEY, enabled ? 'on' : 'off');
}

function secret(): string {
  return (process.env.SITE_AUTH_SECRET ?? readEnv().SITE_AUTH_SECRET ?? '').trim();
}

/** Proves a switch-off link was issued by this installation for this account, so it works without signing in and for nobody else. */
export function alertsOffToken(userId: string): string {
  return createHmac('sha256', secret()).update(`email-alerts-off:${userId}`).digest('hex').slice(0, 32);
}

export function alertsOffTokenValid(userId: string, token: string): boolean {
  if (!secret() || !/^\d+$/.test(userId)) return false;
  const expected = Buffer.from(alertsOffToken(userId));
  const given = Buffer.from(String(token));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------- email

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderAlert(message: Message, name: string | null, dashboardUrl: string, offUrl: string): { subject: string; text: string; html: string } {
  const firstName = (name ?? '').trim().split(/\s+/)[0] ?? '';
  const greeting = firstName ? `Hi ${firstName[0].toUpperCase()}${firstName.slice(1)},` : 'Hi,';
  const link = `${dashboardUrl.replace(/\/+$/, '')}/?tab=${message.action.tab}`;
  const text = [greeting, '', ...message.paragraphs.flatMap((paragraph) => [paragraph, '']), `${message.action.label}: ${link}`, '', 'Owtomate', '', `Stop these emails: ${offUrl}`].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#11141c;max-width:520px">
  <p>${escape(greeting)}</p>
  ${message.paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join('\n  ')}
  <p style="margin:22px 0"><a href="${escape(link)}" style="background:#2f6fd0;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;display:inline-block">${escape(message.action.label)}</a></p>
  <p style="color:#606b7d;font-size:13px">Owtomate<br>You are getting this because something needs your attention on your account. <a href="${escape(offUrl)}" style="color:#606b7d">Stop these emails</a>.</p>
</div>`;
  return { subject: message.subject, text, html };
}

// ---------------------------------------------------------------- the tick

/** The operator's switch for the whole installation (Admin → Config → Email). On unless set to false. */
function alertEmailsOn(): boolean {
  return (process.env.ACCOUNT_ALERT_EMAILS ?? readEnv().ACCOUNT_ALERT_EMAILS ?? 'true').trim() !== 'false';
}

/**
 * Who would be emailed what, right now, without sending anything or remembering anything.
 * For the operator: a look before switching the emails on, and an answer to "why did they get that?".
 */
export async function previewAccountAlerts(): Promise<{ sending: boolean; accounts: Array<{ email: string; optedOut: boolean; alerts: Array<{ key: string; subject: string; waitsMinutes: number; alreadySent: boolean }> }> }> {
  const users = await query<{ id: string; email: string }>('SELECT id::text AS id, email FROM users WHERE blocked_at IS NULL');
  const accounts = [];
  for (const user of users) {
    if (isAdmin(user.email)) continue;
    const facts = await gatherFacts(user.id, user.email).catch(() => null);
    if (!facts) continue;
    const rows = await query<{ kind: string; sent_at: Date | null }>('SELECT kind, sent_at FROM account_alerts WHERE user_id = $1', [user.id]);
    const alerts = alertsFor(facts).map((alert) => ({
      key: alert.key,
      subject: alert.message.subject,
      waitsMinutes: alert.holdMinutes,
      alreadySent: rows.some((row) => row.kind === alert.key && row.sent_at !== null),
    }));
    if (alerts.length) accounts.push({ email: user.email, optedOut: !(await alertsEnabled(user.id)), alerts });
  }
  return { sending: Boolean(digestConfig()) && alertEmailsOn(), accounts };
}

/**
 * Looks at every account and sends what has become true since last time.
 * Cheap enough for the scheduler's tick, but there is no reason to look more
 * often than things change, so it paces itself.
 */
let lastSweep = 0;
const SWEEP_EVERY_MS = 10 * 60_000;

export async function sendAccountAlerts(now: Date = new Date(), force = false): Promise<Array<{ email: string; alert: string }>> {
  if (!force && now.getTime() - lastSweep < SWEEP_EVERY_MS) return [];
  lastSweep = now.getTime();
  const config = digestConfig();
  if (!config || !alertEmailsOn()) return [];

  const users = await query<{ id: string; email: string; name: string | null }>(
    'SELECT id::text AS id, email, name FROM users WHERE blocked_at IS NULL',
  );
  const resend = new Resend(config.apiKey);
  const sent: Array<{ email: string; alert: string }> = [];

  for (const user of users) {
    // An operator's account has no limits to run out of, and sees every problem on the admin page.
    if (isAdmin(user.email)) continue;
    let facts: Facts;
    try {
      facts = await gatherFacts(user.id, user.email);
    } catch {
      continue;
    }

    const active = alertsFor(facts);

    // What is no longer true is forgotten, so that the next time it happens is news again.
    await query('DELETE FROM account_alerts WHERE user_id = $1 AND NOT (kind = ANY($2::text[]))', [user.id, active.map((alert) => alert.key)]);
    if (!(await alertsEnabled(user.id))) continue;

    for (const alert of active) {
      // First sight starts the clock; the email waits until the condition has held long enough.
      await query('INSERT INTO account_alerts (user_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, alert.key]);
      const claim = await query<{ kind: string }>(
        `UPDATE account_alerts SET sent_at = now()
          WHERE user_id = $1 AND kind = $2 AND sent_at IS NULL AND first_seen_at <= now() - make_interval(mins => $3)
          RETURNING kind`,
        [user.id, alert.key, alert.holdMinutes],
      );
      if (!claim.length) continue;

      const base = config.dashboardUrl.replace(/\/+$/, '');
      const offUrl = `${base}/api/email-alerts/off?u=${user.id}&t=${alertsOffToken(user.id)}`;
      const { subject, text, html } = renderAlert(alert.message, user.name, config.dashboardUrl, offUrl);
      try {
        const result = await resend.emails.send({
          from: config.from, to: user.email, subject, text, html,
          headers: { 'List-Unsubscribe': `<${offUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        if (result.error) throw new Error(result.error.message);
        sent.push({ email: user.email, alert: alert.key });
      } catch (error) {
        // Release the claim so the next sweep tries again.
        await query('UPDATE account_alerts SET sent_at = NULL WHERE user_id = $1 AND kind = $2', [user.id, alert.key]).catch(() => {});
        console.warn(`[alerts] ${user.email} ${alert.key}: ${(error as Error).message}`);
      }
    }
  }

  if (sent.length) console.log(`[alerts] sent ${sent.map((entry) => `${entry.alert} → ${entry.email}`).join(', ')}`);
  return sent;
}
