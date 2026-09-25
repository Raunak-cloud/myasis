import { Resend } from 'resend';
import { query } from './db/index.js';
import { adminAddresses } from './billing.js';
import { digestConfig } from './digest.js';
import { readEnv } from './runner.js';

/**
 * Emails to the operator when the service itself is going wrong.
 *
 * Account alerts (alerts.ts) tell a candidate what only they can fix. These
 * tell whoever runs Owtomate what only they can fix: applications mostly
 * failing, a provider out of credit, letters going out un-humanized, submits
 * that may have reached an employer twice. Each problem on 25 Sep 2026 was
 * found hours late by reading logs; every one of them is one entry below.
 *
 * Same shape and bookkeeping as account alerts: an entry says when it applies
 * and how long that must hold (a blip is not an incident); an alert is sent
 * once when it becomes true and again only after it has cleared and returned.
 * Thresholds are rates over enough attempts to mean something, not single
 * failures — one employer's broken form is noise, most of a day's failing is not.
 */

export interface OperatorFacts {
  /** Summed over runs that finished in the last 24 hours. */
  attempted: number;
  applied: number;
  humanizedLetters: number;
  draftLetters: number;
  unconfirmedSubmits: number;
  /** Providers any run of the last 6 hours found out of credit. */
  providersOutOfCredit: string[];
  /** Runs at the head of the finished list that all failed (stopped runs excluded). */
  failedRunsInARow: number;
  /** Same account, same employer and role, sent more than once in the last 7 days. */
  duplicateApplications: Array<{ email: string; company: string; title: string; times: number }>;
  /** CapMonster balance in USD, or null when unknown. */
  capMonsterBalance: number | null;
}

interface Message {
  subject: string;
  /** Plain sentences; the first is the point. */
  paragraphs: string[];
}

interface OperatorAlertKind {
  key: string;
  holdMinutes: number;
  applies(facts: OperatorFacts): Message | null;
}

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

const KINDS: OperatorAlertKind[] = [
  {
    key: 'provider-out-of-credit',
    holdMinutes: 0,
    applies: (f) => f.providersOutOfCredit.length ? {
      subject: `${f.providersOutOfCredit.join(' and ')} is out of credit`,
      paragraphs: [
        `${f.providersOutOfCredit.join(' and ')} refused requests for lack of credit in the last 6 hours, so runs cannot apply.`,
        'Top up the account; runs resume on their next scheduled start.',
      ],
    } : null,
  },
  {
    key: 'capmonster-low',
    holdMinutes: 0,
    applies: (f) => f.capMonsterBalance !== null && f.capMonsterBalance < 2 ? {
      subject: `CapMonster balance is $${f.capMonsterBalance.toFixed(2)}`,
      paragraphs: [`CapMonster has $${f.capMonsterBalance.toFixed(2)} left. When it reaches zero, applications behind a CAPTCHA stop.`],
    } : null,
  },
  {
    key: 'duplicate-applications',
    holdMinutes: 0,
    applies: (f) => f.duplicateApplications.length ? {
      subject: `${f.duplicateApplications.length} role(s) were applied to more than once`,
      paragraphs: [
        'The same account sent the same employer the same role more than once in the last 7 days:',
        ...f.duplicateApplications.slice(0, 10).map((d) => `${d.email}: ${d.title} at ${d.company} (${d.times} times)`),
      ],
    } : null,
  },
  {
    key: 'unconfirmed-submits',
    holdMinutes: 0,
    applies: (f) => f.unconfirmedSubmits >= 2 ? {
      subject: `${f.unconfirmedSubmits} submits in the last day were never confirmed`,
      paragraphs: [
        `${f.unconfirmedSubmits} applications had their submit pressed but no confirmation was recognised. Each may have reached the employer, and none is retried.`,
        'Check the run traces: a confirmation the verifier missed means applications are being under-counted.',
      ],
    } : null,
  },
  {
    key: 'low-success-rate',
    holdMinutes: 60,
    applies: (f) => f.attempted >= 8 && f.applied / f.attempted < 0.25 ? {
      subject: `Only ${pct(f.applied, f.attempted)} of applications succeeded in the last day`,
      paragraphs: [
        `${f.applied} of ${f.attempted} attempted applications were submitted in the last 24 hours.`,
        'A drop like this is usually a board or CAPTCHA change; the run logs name the step each one stopped at.',
      ],
    } : null,
  },
  {
    key: 'humanizer-fallback',
    holdMinutes: 60,
    applies: (f) => {
      const letters = f.humanizedLetters + f.draftLetters;
      return letters >= 4 && f.draftLetters / letters > 0.34 ? {
        subject: `${pct(f.draftLetters, letters)} of cover letters went out un-humanized`,
        paragraphs: [`${f.draftLetters} of ${letters} cover letters in the last day were sent as the plain draft because every humanized rewrite failed its checks.`],
      } : null;
    },
  },
  {
    key: 'runs-failing',
    holdMinutes: 30,
    applies: (f) => f.failedRunsInARow >= 3 ? {
      subject: `The last ${f.failedRunsInARow} runs all failed`,
      paragraphs: [`The last ${f.failedRunsInARow} finished runs ended in an error. The admin dashboard's run list has each one's log.`],
    } : null,
  },
];

/** Which operator alerts apply to these facts. Pure, so the rules can be tested without a database. */
export function operatorAlertsFor(facts: OperatorFacts): Array<{ key: string; holdMinutes: number; message: Message }> {
  return KINDS.flatMap((kind) => {
    const message = kind.applies(facts);
    return message ? [{ key: kind.key, holdMinutes: kind.holdMinutes, message }] : [];
  });
}

async function capMonsterBalance(): Promise<number | null> {
  const key = (process.env.CAPMONSTER_API_KEY ?? readEnv().CAPMONSTER_API_KEY ?? '').trim();
  if (!key) return null;
  try {
    const response = await fetch('https://api.capmonster.cloud/getBalance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKey: key }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { errorId?: number; balance?: number };
    return body.errorId === 0 && typeof body.balance === 'number' ? body.balance : null;
  } catch {
    return null;
  }
}

async function gatherFacts(): Promise<OperatorFacts> {
  const runs = await query<{ health: Record<string, unknown> | null; finished_at: Date }>(
    `SELECT health, finished_at FROM run_starts WHERE finished_at > now() - interval '24 hours' AND health IS NOT NULL`,
  );
  const sum = (field: string) => runs.reduce((total, run) => total + (Number(run.health?.[field]) || 0), 0);
  const recent = runs.filter((run) => Date.now() - new Date(run.finished_at).getTime() < 6 * 3_600_000);
  const providers = [...new Set(recent.flatMap((run) => (Array.isArray(run.health?.providerOutOfCredit) ? run.health!.providerOutOfCredit as string[] : [])))];

  const lastRuns = await query<{ exit_code: number | null; stopped: boolean }>(
    `SELECT exit_code, stopped FROM run_starts WHERE finished_at IS NOT NULL AND NOT stopped ORDER BY finished_at DESC LIMIT 10`,
  );
  let failedRunsInARow = 0;
  for (const run of lastRuns) {
    if (run.exit_code === 0) break;
    failedRunsInARow++;
  }

  const duplicates = await query<{ email: string; company: string; title: string; times: string }>(
    `SELECT u.email, min(a.company) AS company, min(a.title) AS title, count(*) AS times
       FROM applications a JOIN users u ON u.id = a.user_id
      WHERE a.submitted_by_myasis AND a.applied_at > now() - interval '7 days'
      GROUP BY u.email, lower(a.company), lower(a.title)
     HAVING count(*) > 1`,
  );

  return {
    attempted: sum('attempted'),
    applied: sum('applied'),
    humanizedLetters: sum('humanizedLetters'),
    draftLetters: sum('draftLetters'),
    unconfirmedSubmits: sum('unconfirmedSubmits'),
    providersOutOfCredit: providers,
    failedRunsInARow,
    duplicateApplications: duplicates.map((d) => ({ email: d.email, company: d.company, title: d.title, times: Number(d.times) })),
    capMonsterBalance: await capMonsterBalance(),
  };
}

/** What would be sent right now, and what the facts are, without sending. For the admin page. */
export async function previewOperatorAlerts(): Promise<{ recipients: string[]; facts: OperatorFacts; alerts: Array<{ key: string; subject: string }> }> {
  const facts = await gatherFacts();
  return { recipients: adminAddresses(), facts, alerts: operatorAlertsFor(facts).map((alert) => ({ key: alert.key, subject: alert.message.subject })) };
}

const SWEEP_EVERY_MS = 10 * 60_000;
let lastSweep = 0;

/** Called from the scheduler's tick; does real work at most every ten minutes. */
export async function sendOperatorAlerts(now: Date = new Date()): Promise<string[]> {
  if (now.getTime() - lastSweep < SWEEP_EVERY_MS) return [];
  lastSweep = now.getTime();
  const config = digestConfig();
  const recipients = adminAddresses();
  if (!config || !recipients.length) return [];

  const active = operatorAlertsFor(await gatherFacts());
  // What is no longer true is forgotten, so its return is news again.
  await query('DELETE FROM operator_alerts WHERE NOT (kind = ANY($1::text[]))', [active.map((alert) => alert.key)]);
  const resend = new Resend(config.apiKey);
  const sent: string[] = [];
  for (const alert of active) {
    await query('INSERT INTO operator_alerts (kind) VALUES ($1) ON CONFLICT DO NOTHING', [alert.key]);
    const claim = await query<{ kind: string }>(
      `UPDATE operator_alerts SET sent_at = now()
        WHERE kind = $1 AND sent_at IS NULL AND first_seen_at <= now() - make_interval(mins => $2)
        RETURNING kind`,
      [alert.key, alert.holdMinutes],
    );
    if (!claim.length) continue;
    const text = [...alert.message.paragraphs, '', `Admin dashboard: ${config.dashboardUrl.replace(/\/+$/, '')}/?tab=admin`].join('\n\n');
    try {
      const result = await resend.emails.send({ from: config.from, to: recipients, subject: `[Owtomate ops] ${alert.message.subject}`, text });
      if (result.error) throw new Error(result.error.message);
      sent.push(alert.key);
    } catch (error) {
      // Release the claim so the next sweep tries again.
      await query('UPDATE operator_alerts SET sent_at = NULL WHERE kind = $1', [alert.key]).catch(() => {});
      console.warn(`[ops-alerts] ${alert.key}: ${(error as Error).message}`);
    }
  }
  if (sent.length) console.log(`[ops-alerts] sent ${sent.join(', ')} → ${recipients.join(', ')}`);
  return sent;
}
