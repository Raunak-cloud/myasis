-- HR outreach holds only public contact evidence in the shared cache. Private
-- messages and preferences always belong to one account and cascade on deletion.
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
