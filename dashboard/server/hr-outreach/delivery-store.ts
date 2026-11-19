import { randomUUID } from 'node:crypto';
import { adminAddresses } from '../admin-access.js';
import { hrOutreachEligibleSql } from './access.js';
import type { HrBounce } from './bounce.js';
import type { HrDb, HrJob } from './store.js';

export interface HrDeliveryJob extends HrJob {
  delivery_lease: string;
  sent_at: Date | string;
  message_id: string | null;
  thread_id: string | null;
}

const ownerJoins = `JOIN hr_outreach_preferences p ON p.user_id=h.user_id
  JOIN users u ON u.id=h.user_id
  JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id
  JOIN run_starts r ON r.id=a.source_run_id AND r.user_id=a.user_id`;
const confirmed = `p.enabled AND u.blocked_at IS NULL
  AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
  AND r.finished_at IS NOT NULL AND r.hr_ready_at IS NOT NULL`;
const sent = `h.status='sent' AND h.sent_at IS NOT NULL AND nullif(trim(h.message_id),'') IS NOT NULL
  AND nullif(trim(h.to_email),'') IS NOT NULL AND nullif(trim(h.subject),'') IS NOT NULL AND nullif(trim(h.body),'') IS NOT NULL`;
const invalidRecipientCode = "'^550[[:space:]]+5[.]1[.]1$'";

/** Delivery checks inspect an existing send. They never create or resend mail. */
export async function claimDeliveryCheck(db: HrDb): Promise<HrDeliveryJob | null> {
  const { rows } = await db.query(`WITH candidate AS (
    SELECT h.id,a.source_run_id,a.applied_at,a.location FROM hr_outreach h ${ownerJoins}
    WHERE ${confirmed} AND ${sent} AND h.delivery_status='unknown'
      AND ${hrOutreachEligibleSql('$2')} AND h.sent_at>now()-interval '7 days'
      AND h.delivery_check_after<=now() AND (h.delivery_lease IS NULL OR h.delivery_lease_until<=now())
    ORDER BY h.contact_review_required DESC,h.sent_at DESC,h.id FOR UPDATE OF h SKIP LOCKED LIMIT 1)
    UPDATE hr_outreach h SET delivery_lease=$1,delivery_lease_until=now()+interval '10 minutes',delivery_checks=h.delivery_checks+1
    FROM candidate c WHERE h.id=c.id RETURNING h.*,h.id::text,h.user_id::text,h.application_id::text,
      c.source_run_id::text,c.applied_at,c.location`, [randomUUID(), adminAddresses()]);
  return rows[0] ?? null;
}

export async function deliveryCheckAllowed(db: HrDb, job: HrDeliveryJob): Promise<boolean> {
  const { rows } = await db.query(`SELECT h.id FROM hr_outreach h ${ownerJoins}
    WHERE h.id=$1 AND h.user_id=$2 AND h.delivery_lease=$3 AND h.delivery_lease_until>now()
      AND ${confirmed} AND ${sent} AND h.delivery_status='unknown'
      AND h.sent_at>now()-interval '7 days' AND ${hrOutreachEligibleSql('$4')}`,
  [job.id, job.user_id, job.delivery_lease, adminAddresses()]);
  return rows.length > 0;
}

export async function deferDeliveryCheck(db: HrDb, job: HrDeliveryJob): Promise<void> {
  await db.query(`UPDATE hr_outreach SET delivery_lease=NULL,delivery_lease_until=NULL,
    delivery_check_after=now()+interval '30 seconds',delivery_checks=greatest(0,delivery_checks-1)
    WHERE id=$1 AND user_id=$2 AND delivery_lease=$3`, [job.id, job.user_id, job.delivery_lease]);
}

/** The bounce reader returns controlled human reasons, never raw SMTP content. */
export async function completeDeliveryCheck(db: HrDb, job: HrDeliveryJob, bounce: HrBounce | null, failedCheck = false): Promise<void> {
  if (bounce && (!['failed', 'delayed'].includes(bounce.action)
    || !['invalid_recipient', 'temporary_failure', 'policy_rejection'].includes(bounce.kind)
    || bounce.recipient.trim().toLowerCase() !== job.to_email?.trim().toLowerCase()
    || !bounce.noticeMessageId || !Number.isFinite(Date.parse(bounce.observedAt)))) {
    throw new Error('The delivery notice does not match this HR email.');
  }
  if (failedCheck && bounce) throw new Error('An unsuccessful delivery check cannot confirm a return notice.');
  const { rows } = await db.query(`WITH updated AS (
    UPDATE hr_outreach h SET
      delivery_status=CASE WHEN $5::text='failed' THEN 'bounced' ELSE h.delivery_status END,
      delivery_reason=CASE WHEN $5::text IS NOT NULL THEN $7::text ELSE h.delivery_reason END,
      delivery_kind=CASE WHEN $5::text IS NOT NULL THEN $6::text ELSE h.delivery_kind END,
      delivery_diagnostic_code=CASE WHEN $5::text IS NOT NULL THEN $8::text ELSE h.delivery_diagnostic_code END,
      delivery_notice_id=CASE WHEN $5::text IS NOT NULL THEN $9::text ELSE h.delivery_notice_id END,
      delivery_checked_at=CASE WHEN $11::boolean THEN h.delivery_checked_at ELSE now() END,
      delivery_failed_at=CASE WHEN $5::text='failed' THEN $10::timestamptz ELSE h.delivery_failed_at END,
      delivery_check_after=now()+CASE WHEN $11::boolean THEN interval '5 minutes'
        WHEN h.delivery_checks<=1 THEN interval '5 minutes' WHEN h.delivery_checks=2 THEN interval '30 minutes'
        WHEN h.delivery_checks=3 THEN interval '2 hours' WHEN h.delivery_checks=4 THEN interval '6 hours' ELSE interval '24 hours' END,
      delivery_lease=NULL,delivery_lease_until=NULL
    FROM hr_outreach_preferences p,users u,applications a,run_starts r
    WHERE h.id=$1 AND h.user_id=$2 AND h.delivery_lease=$3 AND h.delivery_lease_until>now()
      AND p.user_id=h.user_id AND u.id=h.user_id AND a.id=h.application_id AND a.user_id=h.user_id
      AND r.id=a.source_run_id AND r.user_id=a.user_id AND ${confirmed} AND ${sent}
      AND h.delivery_status='unknown' AND ${hrOutreachEligibleSql('$4')}
      AND ($5::text IS NULL OR lower(trim(h.to_email))=$12::text)
    RETURNING h.id,h.to_email,h.delivery_reason,h.delivery_diagnostic_code),
  invalidated AS (
    INSERT INTO hr_invalid_addresses(email,reason,diagnostic_code,source_outreach_id)
    SELECT lower(trim(to_email)),delivery_reason,delivery_diagnostic_code,id FROM updated
    WHERE $5::text='failed' AND $6::text='invalid_recipient' AND btrim($8::text)~${invalidRecipientCode}
    ON CONFLICT(email) DO UPDATE SET reason=EXCLUDED.reason,diagnostic_code=EXCLUDED.diagnostic_code,
      source_outreach_id=EXCLUDED.source_outreach_id,confirmed_at=now(),cleared_at=NULL
    RETURNING email),
  removed AS (
    DELETE FROM hr_company_contacts c USING invalidated i WHERE lower(trim(c.contact->>'email'))=i.email RETURNING c.company_key)
  SELECT (SELECT count(*) FROM updated)::int AS recorded,(SELECT count(*) FROM removed)::int AS invalidated`,
  [job.id, job.user_id, job.delivery_lease, adminAddresses(), bounce?.action ?? null, bounce?.kind ?? null,
    bounce?.reason ?? null, bounce?.diagnosticCode ?? null, bounce?.noticeMessageId ?? null, bounce?.observedAt ?? null,
    failedCheck, bounce?.recipient.trim().toLowerCase() ?? null]);
  if (!rows[0]?.recorded) throw new Error('This HR delivery check is no longer available.');
}

/** Confirmed invalid public addresses remain excluded until explicitly cleared. */
export async function invalidHrAddresses(db: HrDb): Promise<string[]> {
  const { rows } = await db.query('SELECT email FROM hr_invalid_addresses WHERE cleared_at IS NULL ORDER BY email');
  return rows.map(row => row.email);
}

/** A deliberate retry is a new attempt. The original parent ledger is immutable. */
export async function retryBouncedHrOutreach(userId: string, id: string, db: HrDb): Promise<{ id: string; created: boolean }> {
  if (!/^[1-9]\d{0,18}$/.test(userId) || !/^[1-9]\d{0,18}$/.test(id)) throw new Error('Choose a valid account and HR email.');
  const parent = `SELECT h.* FROM hr_outreach h ${ownerJoins}
    WHERE h.id=$1 AND h.user_id=$2 AND ${confirmed} AND ${sent}
      AND lower(trim(u.email))=ANY($3::text[]) AND a.applied_at>=p.enabled_since
      AND h.delivery_status='bounced' AND h.delivery_kind='invalid_recipient' AND btrim(h.delivery_diagnostic_code)~${invalidRecipientCode}`;
  const params = [id, userId, adminAddresses()];
  const { rows } = await db.query(`WITH parent AS MATERIALIZED (${parent} FOR UPDATE OF h),
    inserted AS (
      INSERT INTO hr_outreach(user_id,application_id,company_key,dedupe_key,job_id,platform,title,company,url,cover_letter,status,phase,retry_of,outreach_attempt)
      SELECT p.user_id,p.application_id,p.company_key,p.dedupe_key||':delivery-retry:'||p.id,p.job_id,p.platform,p.title,p.company,p.url,p.cover_letter,
        'queued','queued',p.id,p.outreach_attempt+1 FROM parent p
      ON CONFLICT(retry_of) WHERE retry_of IS NOT NULL DO NOTHING RETURNING id::text)
    SELECT id,true AS created FROM inserted
    UNION ALL SELECT c.id::text,false AS created FROM hr_outreach c JOIN parent p ON c.retry_of=p.id
      WHERE NOT EXISTS(SELECT 1 FROM inserted) LIMIT 1`, params);
  if (rows[0]) return { id: rows[0].id, created: rows[0].created };
  // A concurrent insert can win after the original statement's snapshot.
  // A fresh, equally owner-scoped read observes it without making another send.
  const existing = await db.query(`WITH parent AS (${parent}) SELECT c.id::text FROM hr_outreach c JOIN parent p ON c.retry_of=p.id`, params);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  throw new Error('This email is not available for an invalid-address retry.');
}
