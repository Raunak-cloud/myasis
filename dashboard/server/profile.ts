import { one } from './db/index.js';
import { upsertProfileRow } from './db/records.js';
import { EMPTY_PROFILE, profileGaps as computeProfileGaps, type CandidateProfile } from './candidate-profile.js';

/**
 * The candidate's own details — Postgres-backed and scoped to one account.
 *
 * Mirrors `billing.ts`'s pattern exactly: every function takes a `userId` and
 * every query is scoped to it. This used to read/write a single shared
 * `seek-bot/data/profile.json` regardless of who was signed in — the exact bug
 * this file now exists to close. The one-time import from that old file lives
 * in `db/migrate-files.ts`, not here.
 */

interface ProfileRow {
  full_name: string;
  email: string;
  phone: string;
  suburb: string;
  state: string;
  postcode: string;
  work_rights: string;
  has_driver_licence: boolean;
  willing_to_relocate: boolean;
  willing_to_travel: string;
  headline: string;
  experience_summary: string;
  skills: string;
  highest_qualification: string;
  expected_salary: string;
  notice_period: string;
  linkedin: string;
  portfolio: string;
  pronouns: string;
  gender: string;
  disability: string;
  referral_source: string;
}

function rowToProfile(row: ProfileRow): CandidateProfile {
  return {
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    suburb: row.suburb,
    state: row.state,
    postcode: row.postcode,
    workRights: row.work_rights,
    hasDriverLicence: row.has_driver_licence,
    willingToRelocate: row.willing_to_relocate,
    willingToTravel: row.willing_to_travel,
    headline: row.headline,
    experienceSummary: row.experience_summary,
    skills: row.skills,
    highestQualification: row.highest_qualification,
    expectedSalary: row.expected_salary,
    noticePeriod: row.notice_period,
    linkedin: row.linkedin,
    portfolio: row.portfolio,
    pronouns: row.pronouns,
    gender: row.gender,
    disability: row.disability,
    referralSource: row.referral_source,
  };
}

export async function loadProfile(userId: string): Promise<CandidateProfile> {
  const row = await one<ProfileRow>(`SELECT * FROM profiles WHERE user_id = $1`, [userId]);
  return row ? rowToProfile(row) : EMPTY_PROFILE;
}

export async function saveProfile(userId: string, patch: Partial<CandidateProfile>): Promise<CandidateProfile> {
  const next = { ...(await loadProfile(userId)), ...patch };
  await upsertProfileRow(userId, next);
  return next;
}

/** Which required fields are still blank — drives the setup checklist. */
export async function profileGaps(userId: string): Promise<string[]> {
  return computeProfileGaps(await loadProfile(userId));
}

export type { CandidateProfile };
