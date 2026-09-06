import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { one } from './index.js';
import { BOT_DIR } from '../runner.js';
import { EMPTY_PROFILE, type CandidateProfile } from '../candidate-profile.js';
import { ensureUserDataDir, userResumeDir, userKnowledgeDir } from '../userdata.js';
import {
  upsertProfileRow, upsertSettingRow, insertResumeRow, insertKnowledgeItemRow,
  insertApplicationRow, insertRunEventRow,
} from './records.js';

const DATA_DIR = resolve(BOT_DIR, 'data');

function readJson<T>(name: string, fallback: T): T {
  const p = resolve(DATA_DIR, name);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function readJsonl(name: string): any[] {
  const p = resolve(DATA_DIR, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

/**
 * Reads the ORIGINAL shared `seek-bot/data/profile.json` (falling back to the
 * legacy `profile.txt`), purely so it can be copied into Postgres for one
 * account. This is a read-only duplicate of what `profile.ts` used to do
 * before it became Postgres-only — kept here, scoped to "one-time migration
 * from the old shared file", rather than in `profile.ts`, whose contract is
 * now "Postgres, per user, nothing else". Never writes back to the file.
 */
function readLegacyProfileFile(): CandidateProfile {
  const PROFILE_JSON = resolve(DATA_DIR, 'profile.json');
  const LEGACY_TXT = resolve(BOT_DIR, '..', 'profile.txt');

  if (existsSync(PROFILE_JSON)) {
    try {
      return { ...EMPTY_PROFILE, ...(JSON.parse(readFileSync(PROFILE_JSON, 'utf8')) as CandidateProfile) };
    } catch {
      /* fall through to legacy txt */
    }
  }
  if (!existsSync(LEGACY_TXT)) return EMPTY_PROFILE;

  const kv = new Map<string, string>();
  for (const line of readFileSync(LEGACY_TXT, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('---')) continue;
    const i = t.indexOf(':');
    if (i === -1) continue;
    const v = t.slice(i + 1).trim();
    if (v) kv.set(t.slice(0, i).trim().toLowerCase(), v);
  }
  const find = (...keys: string[]) => {
    for (const [k, v] of kv) if (keys.some((n) => k.includes(n))) return v;
    return '';
  };
  const yes = (s: string) => /^y/i.test(s.trim());

  return {
    ...EMPTY_PROFILE,
    fullName: find('name'),
    email: find('email'),
    phone: find('phone'),
    suburb: find('suburb'),
    state: find('state'),
    postcode: find('postcode'),
    workRights: find('nationality', 'citizen', 'work right'),
    hasDriverLicence: yes(find('driving', 'licence', 'license')),
    willingToRelocate: yes(find('willing to relocate')),
    willingToTravel: find('willing to travel'),
    highestQualification: find('highest qualification'),
    expectedSalary: find('expected annual salary', 'salary'),
    noticePeriod: find('notice period'),
    linkedin: find('linkedin'),
    portfolio: find('github', 'portfolio', 'website'),
    pronouns: find('pronouns'),
    gender: find('gender'),
    disability: find('disability'),
    referralSource: find('how did you hear') || 'Job board',
  };
}

/**
 * Moves the existing single-user JSON files into the database under one owner.
 *
 * Idempotent: every insert goes through `db/records.ts`, which targets a
 * natural-key unique index with ON CONFLICT DO NOTHING, so re-running this
 * (e.g. to catch up an account whose local files kept growing after the first
 * migration) cannot duplicate a résumé, knowledge item, application or run
 * event. The files are left untouched — the database becoming authoritative
 * is a separate switch, handled by the per-user directories in `run-sync.ts`
 * and the rewritten `profile.ts`/`files.ts`.
 */
export async function migrateFilesToUser(email: string, name?: string) {
  const summary: Record<string, number> = {};

  const user = await one<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
     RETURNING id`,
    [email.toLowerCase(), name ?? null],
  );
  if (!user) throw new Error('could not create or find the user');
  const uid = user.id;

  // ---- profile -----------------------------------------------------------
  const p = readLegacyProfileFile();
  await upsertProfileRow(uid, p);
  summary.profile = 1;

  // ---- settings (from .env, only user-scoped keys) -----------------------
  const envPath = resolve(BOT_DIR, '.env');
  const KEEP = new Set([
    'KEYWORDS', 'TARGET_ROLE', 'PLATFORMS', 'WORK_ARRANGEMENTS', 'JOB_TYPES', 'ONSITE_CITY',
    'MIN_SALARY', 'MIN_SCORE', 'MAX_AGE_DAYS', 'MAX_APPS_PER_RUN',
    'MAX_APPS_PER_DAY', 'MAX_EVALUATIONS', 'PAGES_PER_KEYWORD',
    'COVER_LETTER_MODE', 'COVER_LETTER_TEXT_B64',
  ]);
  let settings = 0;
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const key = t.slice(0, i).trim();
      // Secrets stay in .env — the database holds preferences, not credentials.
      if (!KEEP.has(key)) continue;
      await upsertSettingRow(uid, key, t.slice(i + 1).trim());
      settings++;
    }
  }
  summary.settings = settings;

  // ---- résumés (metadata + the actual binary file) ------------------------
  ensureUserDataDir(uid);
  const resumes = readJson<any[]>('resumes.json', []);
  let resumeFilesCopied = 0;
  for (const r of resumes) {
    await insertResumeRow(uid, {
      label: r.label, fileName: r.fileName, seekName: r.seekName ?? null,
      size: r.size ?? 0, isDefault: !!r.isDefault, uploadedAt: r.uploadedAt ?? new Date(),
    });
    // The rewritten files.ts resolves every résumé under this account's own
    // directory now, not the old shared one — without this copy, the row
    // above would point at a file nobody can reach any more.
    const src = resolve(DATA_DIR, 'resumes', r.fileName);
    const dest = resolve(userResumeDir(uid), r.fileName);
    if (existsSync(src) && !existsSync(dest)) {
      copyFileSync(src, dest);
      resumeFilesCopied++;
    }
  }
  summary.resumes = resumes.length;
  summary.resumeFilesCopied = resumeFilesCopied;

  // ---- knowledge (metadata + the actual binary file) -----------------------
  const knowledge = readJson<any[]>('knowledge.json', []);
  let knowledgeFilesCopied = 0;
  for (const k of knowledge) {
    await insertKnowledgeItemRow(uid, {
      label: k.label, kind: k.kind, fileName: k.fileName ?? null, body: k.text ?? null,
      size: k.size ?? 0, enabled: k.enabled !== false, addedAt: k.addedAt ?? new Date(),
    });
    if (k.kind === 'file' && k.fileName) {
      const src = resolve(DATA_DIR, 'knowledge', k.fileName);
      const dest = resolve(userKnowledgeDir(uid), k.fileName);
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest);
        knowledgeFilesCopied++;
      }
    }
  }
  summary.knowledge = knowledge.length;
  summary.knowledgeFilesCopied = knowledgeFilesCopied;

  // ---- applications ------------------------------------------------------
  const apps = readJson<any[]>('applied.json', []);
  let insertedApps = 0;
  for (const a of apps) {
    const inserted = await insertApplicationRow(uid, {
      jobId: a.jobId, title: a.title, company: a.company, location: a.location ?? '',
      url: a.url ?? '', platform: a.platform ?? 'seek', score: a.score ?? 0,
      salary: a.salary ?? null, workArrangement: a.workArrangement ?? null,
      ageDaysAtApply: a.ageDaysAtApply ?? null, coverLetter: a.coverLetter ?? null,
      answers: a.answers ?? [], scoreReasons: a.scoreReasons ?? [],
      outcome: a.outcome ?? null, appliedAt: a.appliedAt ?? new Date(),
    });
    if (inserted) insertedApps++;
  }
  summary.applications = insertedApps;

  // ---- run events --------------------------------------------------------
  const events = readJsonl('run-log.jsonl');
  for (const e of events) {
    await insertRunEventRow(uid, {
      jobId: e.jobId ?? null, status: e.status ?? 'unknown', title: e.title ?? null,
      company: e.company ?? null, reason: e.reason ?? e.redirectedTo ?? e.error ?? null,
      url: e.url ?? null, ts: e.ts ?? new Date(),
    });
  }
  summary.runEvents = events.length;

  return { userId: uid, summary };
}
