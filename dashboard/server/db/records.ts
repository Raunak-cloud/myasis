import { query } from './index.js';
import type { CandidateProfile } from '../candidate-profile.js';

/**
 * One place for the insert/upsert SQL shared between `migrate-files.ts` (the
 * one-time import from the old shared local files) and `run-sync.ts` (the
 * ongoing, repeatable per-run export/import). Keeping the query shapes here
 * means both call sites can only drift in whether they call a function, not
 * in what the SQL actually does.
 *
 * Every insert here is written to be safely repeatable: ON CONFLICT DO
 * NOTHING against a natural-key unique index (see schema.sql), so re-running
 * a migration or re-syncing the same run twice can never duplicate a row.
 */

export async function upsertProfileRow(uid: string, p: CandidateProfile): Promise<void> {
  await query(
    `INSERT INTO profiles (
       user_id, full_name, email, phone, suburb, state, postcode, work_rights,
       has_driver_licence, willing_to_relocate, willing_to_travel, headline,
       experience_summary, skills, highest_qualification, expected_salary,
       notice_period, linkedin, portfolio, pronouns, gender, disability, referral_source
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (user_id) DO UPDATE SET
       full_name = EXCLUDED.full_name, email = EXCLUDED.email, phone = EXCLUDED.phone,
       suburb = EXCLUDED.suburb, state = EXCLUDED.state, postcode = EXCLUDED.postcode,
       work_rights = EXCLUDED.work_rights, has_driver_licence = EXCLUDED.has_driver_licence,
       willing_to_relocate = EXCLUDED.willing_to_relocate, willing_to_travel = EXCLUDED.willing_to_travel,
       headline = EXCLUDED.headline, experience_summary = EXCLUDED.experience_summary,
       skills = EXCLUDED.skills, highest_qualification = EXCLUDED.highest_qualification,
       expected_salary = EXCLUDED.expected_salary, notice_period = EXCLUDED.notice_period,
       linkedin = EXCLUDED.linkedin, portfolio = EXCLUDED.portfolio,
       pronouns = EXCLUDED.pronouns, gender = EXCLUDED.gender,
       disability = EXCLUDED.disability, referral_source = EXCLUDED.referral_source,
       updated_at = now()`,
    [
      uid, p.fullName, p.email, p.phone, p.suburb, p.state, p.postcode, p.workRights,
      p.hasDriverLicence, p.willingToRelocate, p.willingToTravel, p.headline,
      p.experienceSummary, p.skills, p.highestQualification, p.expectedSalary,
      p.noticePeriod, p.linkedin, p.portfolio, p.pronouns, p.gender, p.disability,
      p.referralSource,
    ],
  );
}

export async function upsertSettingRow(uid: string, key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO settings (user_id, key, value) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [uid, key, value],
  );
}

export interface ResumeRow {
  label: string;
  fileName: string;
  seekName?: string | null;
  size?: number;
  isDefault?: boolean;
  uploadedAt?: string | Date;
}

/** Matched by `resumes_user_file_idx (user_id, file_name)` — see schema.sql. */
export async function insertResumeRow(uid: string, r: ResumeRow): Promise<void> {
  await query(
    `INSERT INTO resumes (user_id, label, file_name, seek_name, size_bytes, is_default, uploaded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, file_name) DO NOTHING`,
    [uid, r.label, r.fileName, r.seekName ?? null, r.size ?? 0, !!r.isDefault, r.uploadedAt ?? new Date()],
  );
}

export interface KnowledgeRow {
  label: string;
  kind: 'file' | 'note';
  fileName?: string | null;
  body?: string | null;
  size?: number;
  enabled?: boolean;
  addedAt?: string | Date;
}

/**
 * File-kind and note-kind items are deduped on different natural keys (see
 * `knowledge_items_user_file_idx` / `..._user_note_idx` in schema.sql), so
 * each kind needs its own ON CONFLICT target — Postgres only allows one
 * arbiter per statement.
 */
export async function insertKnowledgeItemRow(uid: string, k: KnowledgeRow): Promise<void> {
  const conflict = k.kind === 'file' ? '(user_id, file_name) WHERE kind = \'file\'' : '(user_id, label) WHERE kind = \'note\'';
  await query(
    `INSERT INTO knowledge_items (user_id, label, kind, file_name, body, size_bytes, enabled, added_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT ${conflict} DO NOTHING`,
    [uid, k.label, k.kind, k.fileName ?? null, k.body ?? null, k.size ?? 0, k.enabled !== false, k.addedAt ?? new Date()],
  );
}

export interface ApplicationRow {
  jobId: string;
  title: string;
  company: string;
  location?: string;
  url?: string;
  platform?: string;
  score?: number;
  salary?: string | null;
  workArrangement?: string | null;
  ageDaysAtApply?: number | null;
  coverLetter?: string | null;
  answers?: unknown[];
  scoreReasons?: unknown[];
  outcome?: string | null;
  appliedAt?: string | Date;
}

/** Matched by the existing `applications_user_id_job_id_key` UNIQUE(user_id, job_id). */
export async function insertApplicationRow(uid: string, a: ApplicationRow): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO applications (
       user_id, job_id, title, company, location, url, platform, score, salary,
       work_arrangement, age_days_at_apply, cover_letter, answers, score_reasons,
       outcome, applied_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (user_id, job_id) DO NOTHING
     RETURNING id`,
    [
      uid, a.jobId, a.title, a.company, a.location ?? '', a.url ?? '',
      a.platform ?? 'seek', a.score ?? 0, a.salary ?? null, a.workArrangement ?? null,
      a.ageDaysAtApply ?? null, a.coverLetter ?? null,
      JSON.stringify(a.answers ?? []), JSON.stringify(a.scoreReasons ?? []),
      a.outcome ?? null, a.appliedAt ?? new Date(),
    ],
  );
  return rows.length > 0;
}

export interface RunEventRow {
  jobId?: string | null;
  status: string;
  title?: string | null;
  company?: string | null;
  reason?: string | null;
  url?: string | null;
  ts?: string | Date;
  /** Employer questions the run could not answer, for the answer bank. */
  questions?: string[] | null;
}

/** Matched by `run_events_dedupe_idx (user_id, job_id, status, ts)`. */
export async function insertRunEventRow(uid: string, e: RunEventRow): Promise<void> {
  await query(
    `INSERT INTO run_events (user_id, job_id, status, title, company, reason, url, ts, questions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, job_id, status, ts) DO NOTHING`,
    [
      uid, e.jobId ?? null, e.status ?? 'unknown', e.title ?? null, e.company ?? null, e.reason ?? null, e.url ?? null, e.ts ?? new Date(),
      e.questions?.length ? JSON.stringify(e.questions) : null,
    ],
  );
}
