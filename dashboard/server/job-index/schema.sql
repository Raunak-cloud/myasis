-- Dedicated job-index database. No application, billing or identity writes.
CREATE TABLE IF NOT EXISTS indexed_jobs (
 id text PRIMARY KEY CHECK(length(id)=64), canonical_url text UNIQUE NOT NULL,
 title text NOT NULL, company text NOT NULL, description text NOT NULL,
 source text NOT NULL, source_id text NOT NULL, payload jsonb NOT NULL,
 payload_hash text NOT NULL, arrangement text NOT NULL, pay_status text NOT NULL,
 posted_at timestamptz, expires_at timestamptz, first_seen_at timestamptz NOT NULL DEFAULT now(),
 verified_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 search tsvector GENERATED ALWAYS AS (to_tsvector('english',title||' '||company||' '||description)) STORED
);
CREATE INDEX IF NOT EXISTS indexed_jobs_search ON indexed_jobs USING gin(search);
CREATE INDEX IF NOT EXISTS indexed_jobs_tags ON indexed_jobs USING gin(payload jsonb_path_ops);
CREATE INDEX IF NOT EXISTS indexed_jobs_live ON indexed_jobs(verified_at DESC) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS job_versions (
 job_id text NOT NULL REFERENCES indexed_jobs(id) ON DELETE CASCADE,
 payload_hash text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,
 PRIMARY KEY(job_id,payload_hash)
);
-- Private targeting metadata. Raw resumes, contact details and candidate answers never enter this DB.
CREATE TABLE IF NOT EXISTS search_profiles (
 user_id bigint PRIMARY KEY, fingerprint text NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS candidate_job_matches (
 user_id bigint NOT NULL REFERENCES search_profiles(user_id) ON DELETE CASCADE,
 job_id text NOT NULL REFERENCES indexed_jobs(id) ON DELETE CASCADE,
 profile_fingerprint text NOT NULL, job_fingerprint text NOT NULL DEFAULT '', payload jsonb NOT NULL, matched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,job_id)
);
ALTER TABLE candidate_job_matches ADD COLUMN IF NOT EXISTS job_fingerprint text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS candidate_job_matches_owner ON candidate_job_matches(user_id,matched_at DESC);
CREATE TABLE IF NOT EXISTS crawl_tasks (
 key text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('page','feed','search')),
 payload jsonb NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','blocked','failed')),
 priority integer NOT NULL DEFAULT 0, due_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0, lease uuid, lease_until timestamptz, last_error text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crawl_tasks_due ON crawl_tasks(due_at,priority DESC);
CREATE TABLE IF NOT EXISTS crawl_cycles (
 id uuid PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 status text NOT NULL DEFAULT 'running', stats jsonb NOT NULL DEFAULT '{}', error text
);
CREATE TABLE IF NOT EXISTS job_index_config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT true
);
INSERT INTO job_index_config(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS job_index_actions (
 id bigserial PRIMARY KEY, actor_id bigint NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS search_usage (day date PRIMARY KEY,calls integer NOT NULL CHECK(calls>=0 AND calls<=20));
