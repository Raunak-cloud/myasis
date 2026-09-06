-- Myasis schema.
--
-- Every user-owned table carries user_id with ON DELETE CASCADE, so removing an
-- account removes everything belonging to it in one statement. That matters for
-- a product holding résumés, contact details and application history.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  avatar_url    TEXT,
  google_id     TEXT UNIQUE,
  -- Null for Google-only accounts; set for local email/password sign-in.
  password_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

-- The candidate details form. One row per user, mirroring the flat shape the
-- UI already posts so there is nothing to reshape.
CREATE TABLE IF NOT EXISTS profiles (
  user_id               BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name             TEXT NOT NULL DEFAULT '',
  email                 TEXT NOT NULL DEFAULT '',
  phone                 TEXT NOT NULL DEFAULT '',
  suburb                TEXT NOT NULL DEFAULT '',
  state                 TEXT NOT NULL DEFAULT '',
  postcode              TEXT NOT NULL DEFAULT '',
  work_rights           TEXT NOT NULL DEFAULT '',
  has_driver_licence    BOOLEAN NOT NULL DEFAULT false,
  willing_to_relocate   BOOLEAN NOT NULL DEFAULT false,
  willing_to_travel     TEXT NOT NULL DEFAULT '',
  headline              TEXT NOT NULL DEFAULT '',
  experience_summary    TEXT NOT NULL DEFAULT '',
  skills                TEXT NOT NULL DEFAULT '',
  highest_qualification TEXT NOT NULL DEFAULT '',
  expected_salary       TEXT NOT NULL DEFAULT '',
  notice_period         TEXT NOT NULL DEFAULT '',
  linkedin              TEXT NOT NULL DEFAULT '',
  portfolio             TEXT NOT NULL DEFAULT '',
  pronouns              TEXT NOT NULL DEFAULT '',
  gender                TEXT NOT NULL DEFAULT '',
  disability            TEXT NOT NULL DEFAULT '',
  referral_source       TEXT NOT NULL DEFAULT '',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Search criteria, previously .env. Key/value keeps it schema-stable as
-- settings come and go.
CREATE TABLE IF NOT EXISTS settings (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS resumes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  seek_name   TEXT,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  -- What this résumé is for, e.g. "React/frontend roles" — read by the AI
  -- résumé picker (seek-bot/src/resume.ts) when more than one is on file.
  notes       TEXT NOT NULL DEFAULT '',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resumes_user_idx ON resumes(user_id);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('file', 'note')),
  file_name  TEXT,
  body       TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_user_idx ON knowledge_items(user_id);

-- What was actually sent to an employer. Append-only apart from `outcome`,
-- which the user records themselves.
CREATE TABLE IF NOT EXISTS applications (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id            TEXT NOT NULL,
  title             TEXT NOT NULL,
  company           TEXT NOT NULL,
  location          TEXT NOT NULL DEFAULT '',
  url               TEXT NOT NULL DEFAULT '',
  platform          TEXT NOT NULL DEFAULT 'seek',
  score             INTEGER NOT NULL DEFAULT 0,
  salary            TEXT,
  work_arrangement  TEXT,
  age_days_at_apply INTEGER,
  cover_letter      TEXT,
  answers           JSONB NOT NULL DEFAULT '[]'::jsonb,
  score_reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome           TEXT CHECK (outcome IN ('interview', 'rejected', 'closed')),
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS applications_user_idx ON applications(user_id, applied_at DESC);

-- Replaces run-log.jsonl. Feeds the "Needs you" screen.
CREATE TABLE IF NOT EXISTS run_events (
  id       BIGSERIAL PRIMARY KEY,
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id   TEXT,
  status   TEXT NOT NULL,
  title    TEXT,
  company  TEXT,
  reason   TEXT,
  url      TEXT,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_events_user_idx ON run_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS run_events_status_idx ON run_events(user_id, status);

-- Set when the user clears an item off the "Needs attention" screen. The row
-- itself is kept: this table is the run history, and a dismissed blocker is
-- still a record of what a run actually did.
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

-- One-time, non-renewing job-search passes purchased through hosted Checkout.
-- Session id is unique so webhook retries can never grant the same purchase twice.
CREATE TABLE IF NOT EXISTS billing_purchases (
  id                         BIGSERIAL PRIMARY KEY,
  user_id                    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id   TEXT,
  plan_key                   TEXT NOT NULL,
  applications_granted       INTEGER NOT NULL CHECK (applications_granted > 0),
  amount_paid                INTEGER NOT NULL CHECK (amount_paid >= 0),
  currency                   TEXT NOT NULL DEFAULT 'aud',
  paid_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_purchases_user_idx ON billing_purchases(user_id, paid_at DESC);

CREATE TABLE IF NOT EXISTS application_credit_grants (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purchase_id   BIGINT NOT NULL UNIQUE REFERENCES billing_purchases(id) ON DELETE CASCADE,
  credits_total INTEGER NOT NULL CHECK (credits_total > 0),
  credits_used  INTEGER NOT NULL DEFAULT 0 CHECK (credits_used >= 0 AND credits_used <= credits_total),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS application_credit_grants_active_idx
  ON application_credit_grants(user_id, expires_at) WHERE credits_used < credits_total;

CREATE TABLE IF NOT EXISTS monthly_application_usage (
  user_id                BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_start            DATE NOT NULL,
  successful_applications INTEGER NOT NULL DEFAULT 0 CHECK (successful_applications >= 0),
  rehearsals_completed    INTEGER NOT NULL DEFAULT 0 CHECK (rehearsals_completed >= 0),
  PRIMARY KEY (user_id, month_start)
);

-- Existing installations created before rehearsal limits need the new counter.
ALTER TABLE monthly_application_usage
  ADD COLUMN IF NOT EXISTS rehearsals_completed INTEGER NOT NULL DEFAULT 0
  CHECK (rehearsals_completed >= 0);

-- Existing installations created before résumé notes were added need the column.
ALTER TABLE resumes ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

-- Natural-key dedupe so migrate-files.ts and the per-run sync in db/records.ts
-- can both insert with ON CONFLICT DO NOTHING and be safely re-run/repeated
-- without duplicating a user's résumés, knowledge items or run history.
CREATE UNIQUE INDEX IF NOT EXISTS resumes_user_file_idx ON resumes(user_id, file_name);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_items_user_file_idx
  ON knowledge_items(user_id, file_name) WHERE kind = 'file';
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_items_user_note_idx
  ON knowledge_items(user_id, label) WHERE kind = 'note';
CREATE UNIQUE INDEX IF NOT EXISTS run_events_dedupe_idx
  ON run_events(user_id, job_id, status, ts);
