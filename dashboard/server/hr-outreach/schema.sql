-- HR outreach holds only public contact evidence in the shared cache. Private
-- messages and preferences always belong to one account and cascade on deletion.
-- New submissions retain their server-bound applying run. Historical rows are
-- deliberately not assigned to runs by their timestamp.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS source_run_id BIGINT REFERENCES run_starts(id) ON DELETE SET NULL;
ALTER TABLE application_email_sends ADD COLUMN IF NOT EXISTS source_run_id BIGINT REFERENCES run_starts(id) ON DELETE SET NULL;
ALTER TABLE run_starts ADD COLUMN IF NOT EXISTS hr_ready_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS hr_outreach_preferences (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  enabled_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_company_contacts (
  company_key TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  contact JSONB,
  reason TEXT NOT NULL DEFAULT '',
  validated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_validation_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hr_contacts_due_idx ON hr_company_contacts(next_validation_at);
CREATE TABLE IF NOT EXISTS hr_outreach (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  company_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  url TEXT NOT NULL,
  cover_letter TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','researching','sending','sent','skipped','error','unconfirmed')),
  contact JSONB,
  to_email TEXT,
  subject TEXT,
  body TEXT,
  reason TEXT,
  message_id TEXT,
  thread_id TEXT,
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0 CHECK(cost_usd>=0),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  send_started_at TIMESTAMPTZ,
  UNIQUE(user_id,application_id),
  UNIQUE(user_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS hr_outreach_owner_idx ON hr_outreach(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS hr_outreach_queue_idx ON hr_outreach(status,available_at);
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS phase TEXT CHECK(phase IN ('queued','researching','writing','sending','checking'));
-- Discovery and transport are separate outcomes. Diagnostics stay server-side.
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS lookup_outcome TEXT CHECK(lookup_outcome IN ('found','no_contact','company_unverified','access_blocked','temporarily_unavailable','incomplete'));
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS lookup_checked_at TIMESTAMPTZ;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS lookup_diagnostics JSONB;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS retry_allowed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS contact_review_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS contact_review_reason TEXT;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS contact_assessed_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hr_company_contacts ADD COLUMN IF NOT EXISTS lookup_outcome TEXT;
ALTER TABLE hr_company_contacts ADD COLUMN IF NOT EXISTS lookup_diagnostics JSONB;
ALTER TABLE hr_company_contacts ADD COLUMN IF NOT EXISTS contact_assessed_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hr_company_contacts ADD COLUMN IF NOT EXISTS lookup_context_key TEXT;
-- Sending and delivery are separate facts. A rejection never erases a send.
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'unknown' CHECK(delivery_status IN ('unknown','bounced'));
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_reason TEXT;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_checked_at TIMESTAMPTZ;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_failed_at TIMESTAMPTZ;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_kind TEXT CHECK(delivery_kind IN ('invalid_recipient','temporary_failure','policy_rejection'));
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_diagnostic_code TEXT;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_notice_id TEXT;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_check_after TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_lease TEXT;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS delivery_lease_until TIMESTAMPTZ;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS retry_of BIGINT REFERENCES hr_outreach(id) ON DELETE CASCADE;
ALTER TABLE hr_outreach ADD COLUMN IF NOT EXISTS outreach_attempt INTEGER NOT NULL DEFAULT 1 CHECK(outreach_attempt>=1);
ALTER TABLE hr_outreach DROP CONSTRAINT IF EXISTS hr_outreach_user_id_application_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS hr_outreach_primary_application_idx ON hr_outreach(user_id,application_id) WHERE retry_of IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hr_outreach_retry_parent_idx ON hr_outreach(retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_outreach_delivery_due_idx ON hr_outreach(delivery_check_after) WHERE status='sent' AND delivery_status='unknown';
-- Public business inbox state only. Candidate messages and DSNs stay private.
CREATE TABLE IF NOT EXISTS hr_invalid_addresses (
  email TEXT PRIMARY KEY CHECK(email=lower(trim(email))),
  reason TEXT NOT NULL,
  diagnostic_code TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_outreach_id BIGINT REFERENCES hr_outreach(id) ON DELETE SET NULL,
  cleared_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hr_application_run_idx ON applications(user_id,source_run_id);
-- HR daily usage is tracked independently of job discovery, without a quota.
CREATE TABLE IF NOT EXISTS hr_contact_search_usage (
  day DATE PRIMARY KEY,
  calls INTEGER NOT NULL CHECK(calls>=0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
