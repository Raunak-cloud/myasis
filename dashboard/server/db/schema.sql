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
  -- NULL means the credits never expire, which is the normal state: passes are
  -- sold without a time limit. A date is only ever set to end a pass early.
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS application_credit_grants_active_idx
  ON application_credit_grants(user_id, expires_at) WHERE credits_used < credits_total;

-- The September 2026 allowance increase applies to passes that are still
-- active, not only to purchases made after the pricing change. The purchase
-- value is the idempotency guard: once raised, rerunning the schema cannot add
-- the difference a second time.
UPDATE application_credit_grants AS g
   SET credits_total = g.credits_total + (
     CASE p.plan_key
       WHEN 'job-search-pass' THEN 150
       WHEN 'intensive-pass' THEN 320
     END - p.applications_granted
   )
  FROM billing_purchases AS p
 WHERE g.purchase_id = p.id
   AND (g.expires_at IS NULL OR g.expires_at > now())
   AND (
     (p.plan_key = 'job-search-pass' AND p.applications_granted < 150)
     OR (p.plan_key = 'intensive-pass' AND p.applications_granted < 320)
   );

UPDATE billing_purchases
   SET applications_granted = CASE plan_key
     WHEN 'job-search-pass' THEN 150
     WHEN 'intensive-pass' THEN 320
   END
 WHERE (plan_key = 'job-search-pass' AND applications_granted < 150)
    OR (plan_key = 'intensive-pass' AND applications_granted < 320);

-- Passes are no longer time-limited. The column stays nullable rather than
-- being dropped so a pass can still be ended early from the admin page.
-- Grants sold under the old 30-day terms lose their deadline too: a customer
-- who paid for credits keeps them.
ALTER TABLE application_credit_grants ALTER COLUMN expires_at DROP NOT NULL;
UPDATE application_credit_grants SET expires_at = NULL WHERE expires_at > now();

CREATE TABLE IF NOT EXISTS monthly_application_usage (
  user_id                BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_start            DATE NOT NULL,
  successful_applications INTEGER NOT NULL DEFAULT 0 CHECK (successful_applications >= 0),
  PRIMARY KEY (user_id, month_start)
);

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

-- Employer questions a run could not answer from the profile, so the
-- dashboard can ask the candidate once (see saved_answers).
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS questions JSONB;

-- Submitted on an employer's own site rather than the job board. The stored
-- `url` is always the board listing, so the daily employer-site allowance
-- cannot be counted from it.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS external BOOLEAN NOT NULL DEFAULT false;

-- Jobs discovered as "already applied" remain available to duplicate
-- protection, but they are not submissions made by Myasis and must stay out
-- of customer history, totals and digests. Live submissions are scored before
-- submit. A legacy row with neither a score nor a submitted cover letter came
-- from a discovery-only path; recovered submission artefacts remain visible.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS submitted_by_myasis BOOLEAN NOT NULL DEFAULT true;
UPDATE applications SET submitted_by_myasis = false WHERE score = 0 AND cover_letter IS NULL;

-- Read-only Gmail access, per account, so a run can pick up the one-time
-- codes employer sites email during an application. A secret: never served
-- to the browser, only handed to that account's own run.
CREATE TABLE IF NOT EXISTS google_connections (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,
  gmail_email   TEXT,
  scope         TEXT,
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The candidate's answer bank: answered once in the dashboard, reused on
-- every later form that asks the same thing.
CREATE TABLE IF NOT EXISTS saved_answers (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, question)
);

-- Every run this installation has started, written before the child is
-- spawned rather than after it finishes.
--
-- It answers two questions that both need the same fact: how many manual runs
-- an Intensive Pass has used today, and whether the scheduler has already
-- fired an automatic run for an account. Recording the attempt rather than
-- the success is deliberate — a run that starts and dies has still been
-- attempted against real employers, and a scheduler restarted mid-run must
-- not fire a duplicate.
CREATE TABLE IF NOT EXISTS run_starts (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode       TEXT NOT NULL,
  -- 'manual' (a person pressed start) or 'auto' (the scheduler).
  trigger    TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_starts_user_idx ON run_starts(user_id, trigger, started_at DESC);

-- One row per account per day the evening summary was sent.
--
-- The unique key is the guard: the scheduler ticks every minute after 9pm, so
-- something has to make the send happen once. A row is claimed before the
-- email goes out and removed again if it fails, which retries on the next
-- tick rather than leaving a candidate with no summary at all.
CREATE TABLE IF NOT EXISTS daily_digests (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- One row per account per problem it has been (or is about to be) emailed
-- about: out of applications, signed out of a board, runs failing, setup never
-- finished (server/alerts.ts).
--
-- The row is the memory that makes an alert a one-off. It appears when the
-- problem is first seen, `sent_at` is set when the email goes out, and the row
-- is deleted when the problem goes away — so the same problem coming back
-- later is news again, and a problem that is still there is never repeated.
-- `first_seen_at` is what lets an alert wait: a board that signs itself back
-- in within the hour never costs anyone an email.
-- Dedicated addresses for paying accounts, synced from the operator's Webshare
-- plans (server/proxy-pool.ts). One proxy per account at most; last_user_id
-- and released_at let an account get its old address back, and keep an
-- address given up from reaching another account until it has cooled down.
CREATE TABLE IF NOT EXISTS pool_proxies (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL,
  address      TEXT NOT NULL,
  port         INTEGER NOT NULL,
  username     TEXT NOT NULL,
  password     TEXT NOT NULL,
  country_code TEXT,
  city         TEXT,
  valid        BOOLEAN NOT NULL DEFAULT true,
  user_id      BIGINT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  TIMESTAMPTZ,
  last_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  released_at  TIMESTAMPTZ,
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_alerts (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  PRIMARY KEY (user_id, kind)
);

-- Where an application was submitted when it left the job board, and what
-- Myasis did on the candidate's behalf while applying: an account created or
-- signed in to, a document added to their profile, a code read from their inbox.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS site TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Accounts on employer sites that Myasis created or used for a candidate,
-- whatever became of the application that needed them. One row per site and
-- email. The password is never stored: it is derived from SITE_AUTH_SECRET,
-- the email and the site, and shown only to the account's owner on request.
CREATE TABLE IF NOT EXISTS site_accounts (
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site              TEXT NOT NULL,
  email             TEXT NOT NULL,
  created_by_myasis BOOLEAN NOT NULL DEFAULT false,
  job_title         TEXT,
  company           TEXT,
  first_used_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, site, email)
);

-- How each run ended, written by the runner when the run's process exits, and
-- who started it when that was an admin acting for the account. log_file is
-- the run's saved console, under the account's data folder.
ALTER TABLE run_starts ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE run_starts ADD COLUMN IF NOT EXISTS exit_code INTEGER;
ALTER TABLE run_starts ADD COLUMN IF NOT EXISTS applied INTEGER;
ALTER TABLE run_starts ADD COLUMN IF NOT EXISTS log_file TEXT;
ALTER TABLE run_starts ADD COLUMN IF NOT EXISTS started_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
-- A run somebody pressed Stop on ends with the same exit code as one that
-- crashed. This is what tells them apart, so "your runs keep failing" is never
-- said about runs the person ended themselves.
ALTER TABLE run_starts ADD COLUMN IF NOT EXISTS stopped BOOLEAN NOT NULL DEFAULT false;
-- Set by an admin. A blocked account cannot sign in, keeps no session, and is left out of every schedule.
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS run_starts_recent_idx ON run_starts(started_at DESC);

-- One row per page a visitor looked at, for the operator's Visitors view.
--
-- Written by the page itself: a beacon on arrival opens the row, a beacon on
-- leaving closes it with how long the page was actually in front of them. The
-- address is resolved to a place at write time from the offline database named
-- by GEOIP_DB — nothing is sent to a third party to do it. An address with a
-- place is personal information, so rows older than the retention period are
-- removed daily (see visits.ts): the numbers need history, not the addresses.
CREATE TABLE IF NOT EXISTS page_views (
  id           BIGSERIAL PRIMARY KEY,
  visitor_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  page         TEXT NOT NULL,
  referrer     TEXT,
  ip           INET,
  country_code TEXT,
  country      TEXT,
  region       TEXT,
  city         TEXT,
  latitude     DOUBLE PRECISION,
  longitude    DOUBLE PRECISION,
  user_agent   TEXT,
  device       TEXT,
  browser      TEXT,
  os           TEXT,
  screen       TEXT,
  language     TEXT,
  time_zone    TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS page_views_started_idx ON page_views(started_at DESC);
CREATE INDEX IF NOT EXISTS page_views_session_idx ON page_views(session_id, started_at);
CREATE INDEX IF NOT EXISTS page_views_country_idx ON page_views(country_code, started_at DESC);

-- Addresses whose visits are not customers': the operators' own homes and
-- offices. Nothing from them is recorded, and what was recorded before they
-- were listed is left out of every report.
CREATE TABLE IF NOT EXISTS ignored_addresses (
  ip         INET PRIMARY KEY,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A connection from this machine itself is an operator's — an SSH tunnel to
-- the dashboard, a check from the shell — never a customer.
INSERT INTO ignored_addresses (ip, note) VALUES ('127.0.0.1', 'This machine'), ('::1', 'This machine')
ON CONFLICT (ip) DO NOTHING;

-- Features with a per-account allowance that is not applications: one row
-- per use, so "how many times has this account used X" is a count, and the
-- allowance can be changed without touching the record.
CREATE TABLE IF NOT EXISTS feature_uses (
  id      BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feature_uses_user_feature_idx ON feature_uses (user_id, feature);
