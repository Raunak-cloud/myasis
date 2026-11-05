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
CREATE INDEX IF NOT EXISTS candidate_job_matches_job ON candidate_job_matches(job_id,user_id);
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
-- Rejected/uncertain reviews retain only hashes and a verdict, never vacancies or CVs.
CREATE TABLE IF NOT EXISTS fit_decisions (
 user_id bigint NOT NULL REFERENCES search_profiles(user_id) ON DELETE CASCADE,
 profile_fingerprint text NOT NULL,job_fingerprint text NOT NULL,policy text NOT NULL,
 decision text NOT NULL CHECK(decision IN ('match','no_match','uncertain')),match jsonb,expires_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,profile_fingerprint,job_fingerprint,policy)
);
CREATE TABLE IF NOT EXISTS fit_review_requests (
 id uuid PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),reserved_usd numeric NOT NULL CHECK(reserved_usd>0),
 amount_usd numeric,basis text NOT NULL DEFAULT 'unknown',status text NOT NULL DEFAULT 'requested'
);
ALTER TABLE job_index_config ADD COLUMN IF NOT EXISTS match_policy text;
-- Rebuild from previously readable publisher sources once when activating the
-- gate. Do not retry refused sources or reset application/schedule history.
UPDATE crawl_tasks SET due_at=now() WHERE state='done' AND kind IN ('feed','page') AND (SELECT match_policy FROM job_index_config WHERE singleton) IS DISTINCT FROM 'resume-fit-v1';
UPDATE job_index_config SET match_policy='resume-fit-v1' WHERE singleton;
-- Catalog-only migration: remove legacy unreviewed entries and their public
-- versions. Customer applications, credentials and activity are in another DB.
DELETE FROM candidate_job_matches WHERE payload#>>'{review,policy}' IS DISTINCT FROM 'resume-fit-v1';
DELETE FROM indexed_jobs j WHERE NOT EXISTS(SELECT 1 FROM candidate_job_matches m WHERE m.job_id=j.id AND m.job_fingerprint=j.payload_hash);
UPDATE crawl_tasks SET payload=jsonb_set(payload,'{job}',jsonb_strip_nulls(jsonb_build_object('id',payload#>'{job,id}','url',payload#>'{job,url}','platform',payload#>'{job,platform}','source',payload#>'{job,source}'))) WHERE payload ? 'job' AND payload#>'{job}' IS NOT NULL;
