import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from './index.js';
import { insertApplicationRow, insertRunEventRow } from './records.js';
import { ensureUserDataDir, userChromeDir } from '../userdata.js';
import { chromeGoogleAccounts } from '../chrome-accounts.js';
import { normaliseQuestions } from '../attention.js';
import { loadProfile } from '../profile.js';
import { listResumes, listKnowledge } from '../files.js';
import { listAnswers } from '../answers.js';
import type { CandidateProfile } from '../candidate-profile.js';

/**
 * Bridges Postgres (authoritative) and the per-user directory seek-bot
 * actually runs against (`seek-bot/data/users/<userId>/`), in both
 * directions, around every run:
 *
 *  - `exportUserForRun` (Postgres → files), called by `runner.ts` right
 *    before `spawn()`, so the child sees this account's real profile,
 *    résumés, knowledge and application history — never anyone else's.
 *  - `syncRunResultsToDb` (files → Postgres), called from the `child.on
 *    ('close', …)` handler, so what the run actually did lands back in this
 *    account's rows. This reuses `db/records.ts`'s idempotent inserts — the
 *    same ones `migrate-files.ts` uses — turning that one-time migration
 *    logic into a repeatable per-run sync, as intended.
 */

/**
 * Renders the profile in the same `key: value` text format seek-bot's own
 * `loadProfile()` (config.ts) parses — the format `profile.txt` has always
 * used. Reuses that exact vocabulary (not a new one) so the parser's
 * substring matching (`k.includes(needle)`) resolves every field correctly.
 */
function profileToLegacyText(p: CandidateProfile): string {
  const lines: Array<[string, string]> = [
    ['Full name', p.fullName],
    ['Email', p.email],
    ['Phone', p.phone],
    // seek-bot's own `nationality` field has no dashboard equivalent —
    // work rights is the closest thing collected, and is a reasonable
    // stand-in for what that field is actually used for (eligibility).
    ['Nationality', p.workRights],
    ['Driving', p.hasDriverLicence ? 'Yes' : 'No'],
    ['Suburb', p.suburb],
    ['State', p.state],
    ['Postcode', p.postcode],
    ['LinkedIn', p.linkedin],
    ['GitHub/portfolio', p.portfolio],
    ['Highest qualification', p.highestQualification],
    ['Expected annual salary', p.expectedSalary],
    ['Notice period', p.noticePeriod],
    ['Willing to relocate', p.willingToRelocate ? 'Yes' : 'No'],
    ['Willing to travel', p.willingToTravel],
    ['Pronouns', p.pronouns],
    ['Gender', p.gender],
    ['Disability', p.disability],
    ['How did you hear about us', p.referralSource],
  ];
  return lines.map(([k, v]) => `${k}: ${v ?? ''}`).join('\n') + '\n';
}

interface ApplicationExportRow {
  job_id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  platform: string;
  score: number;
  salary: string | null;
  work_arrangement: string | null;
  age_days_at_apply: number | null;
  cover_letter: string | null;
  answers: unknown;
  score_reasons: unknown;
  applied_at: Date | string;
  external: boolean;
}

/**
 * Regenerates this account's slice of `seek-bot/data/users/<userId>/` from
 * Postgres immediately before a run starts. Safe to call any number of
 * times — every file here is fully derived and gets overwritten, never
 * merged; only `resumes/`, `knowledge/` (the binary files themselves) and
 * `queue.json` are left alone, since those are canonical in the directory,
 * not in Postgres (see `userdata.ts`).
 */
export async function exportUserForRun(userId: string): Promise<{ dir: string; overrides: Record<string, string> }> {
  const dir = ensureUserDataDir(userId);

  const profile = await loadProfile(userId);
  writeFileSync(resolve(dir, 'profile.txt'), profileToLegacyText(profile));

  const resumes = await listResumes(userId);
  writeFileSync(resolve(dir, 'resumes.json'), JSON.stringify(resumes, null, 2));

  const knowledge = await listKnowledge(userId);
  writeFileSync(resolve(dir, 'knowledge.json'), JSON.stringify(knowledge, null, 2));

  // The answer bank, read by seek-bot's knowledge.ts on every form step.
  const answers = await listAnswers(userId);
  writeFileSync(resolve(dir, 'answers.json'), JSON.stringify(answers.map(({ question, answer }) => ({ question, answer })), null, 2));
  /**
   * Employer-site applications SUBMITTED today, so the daily ceiling holds
   * across runs. Only successful ones count: a form that defeats the agent
   * costs model calls, but it must not consume the candidate's allowance.
   */
  const externalToday = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM applications
      WHERE user_id = $1 AND external AND applied_at >= date_trunc('day', now())`,
    [userId],
  );

  const apps = await query<ApplicationExportRow>(
    `SELECT job_id, title, company, location, url, platform, score, salary,
            work_arrangement, age_days_at_apply, cover_letter, answers, score_reasons, applied_at, external
       FROM applications WHERE user_id = $1 ORDER BY applied_at`,
    [userId],
  );
  const appliedJson = apps.map((a) => ({
    jobId: a.job_id,
    title: a.title,
    company: a.company,
    location: a.location,
    url: a.url,
    appliedAt: new Date(a.applied_at).toISOString(),
    score: a.score,
    platform: a.platform,
    salary: a.salary ?? undefined,
    workArrangement: a.work_arrangement ?? undefined,
    ageDaysAtApply: a.age_days_at_apply ?? undefined,
    coverLetter: a.cover_letter ?? undefined,
    answers: a.answers ?? [],
    scoreReasons: a.score_reasons ?? [],
    external: a.external === true,
  }));
  writeFileSync(resolve(dir, 'applied.json'), JSON.stringify(appliedJson, null, 2));

  // Fresh log for this run only, so `syncRunResultsToDb` reads exactly what
  // THIS run wrote — never re-syncs an earlier run's already-migrated lines.
  const logPath = resolve(dir, 'run-log.jsonl');
  if (existsSync(logPath)) unlinkSync(logPath);

  return {
    dir,
    overrides: {
      /**
       * Point the run at THIS account's exported profile.
       *
       * Without this the child falls back to `PROFILE_PATH` in seek-bot/.env,
       * which is the original single-user `profile.txt` — so every account's
       * run silently searched and applied as that one person (their name,
       * suburb, nationality and driving status), no matter who started it.
       * The per-account file was being written correctly all along; nothing
       * was reading it.
       */
      PROFILE_PATH: resolve(dir, 'profile.txt'),
      // seek-bot's config.ts sources these two fields from the environment,
      // not from profile.txt (see config.ts) — pass them the same way the
      // dashboard already passes MIN_SCORE etc. so this run uses THIS
      // account's experience/skills instead of the shared .env defaults.
      EXPERIENCE_SUMMARY: profile.experienceSummary,
      SKILLS: profile.skills,
      /**
       * Where "within N km" is measured from: the account's own address, so
       * the radius setting is a single number the user picks rather than a
       * location they have to retype. Empty when the profile has no suburb,
       * which leaves the radius inert rather than searching from nowhere.
       */
      SEARCH_LOCATION: [profile.suburb, profile.state, profile.postcode]
        .map((part) => (part ?? '').trim())
        .filter(Boolean)
        .join(' '),
      /**
       * Same class of bleed: both default from the shared .env, which holds
       * the original account's stack exclusions and clearance. Neither is a
       * per-account dashboard setting yet, so send explicit empty values
       * rather than let one account's rules silently filter another's run.
       */
      EXCLUDED_DOMAINS: '',
      SECURITY_CLEARANCE: 'None held',
      /**
       * The mailbox the run can read in its own browser, when there is one.
       *
       * The API route above needs Google's restricted `gmail.readonly` scope,
       * which an unverified app cannot have. A dedicated Gmail signed in to
       * this profile's Chrome gets to the same codes with no scope at all, so
       * the run is told the address exists and reads it from the session.
       */
      GMAIL_BROWSER_ACCOUNT: chromeGoogleAccounts(userId)[0] ?? '',
      EXTERNAL_ATTEMPTS_TODAY: externalToday[0]?.n ?? '0',
      /**
       * This account's own Chrome profile, holding its own SEEK sign-in.
       * Without it every run shares one profile, which Chrome locks against
       * concurrent use and which would send one account's applications under
       * whichever account signed in last.
       */
      CHROME_PROFILE_DIR: userChromeDir(userId),
    },
  };
}

/**
 * Reads back what the run just produced and folds it into Postgres. Reusing
 * `db/records.ts`'s ON CONFLICT DO NOTHING inserts means this can run after
 * every single run without ever double-counting an application already
 * synced from a previous one.
 */
export async function syncRunResultsToDb(
  userId: string,
  dir: string,
): Promise<{ applications: number; runEvents: number }> {
  let applications = 0;
  const appliedPath = resolve(dir, 'applied.json');
  if (existsSync(appliedPath)) {
    try {
      const apps = JSON.parse(readFileSync(appliedPath, 'utf8')) as Array<Record<string, any>>;
      for (const a of apps) {
        const inserted = await insertApplicationRow(userId, {
          jobId: a.jobId,
          title: a.title,
          company: a.company,
          location: a.location ?? '',
          url: a.url ?? '',
          platform: a.platform ?? 'seek',
          score: a.score ?? 0,
          salary: a.salary ?? null,
          workArrangement: a.workArrangement ?? null,
          ageDaysAtApply: a.ageDaysAtApply ?? null,
          coverLetter: a.coverLetter ?? null,
          answers: a.answers ?? [],
          scoreReasons: a.scoreReasons ?? [],
          appliedAt: a.appliedAt ?? new Date(),
          external: a.external === true,
        });
        if (inserted) applications++;
      }
    } catch {
      /* leave applied.json as-is for inspection; nothing usable to sync */
    }
  }

  let runEvents = 0;
  const logPath = resolve(dir, 'run-log.jsonl');
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, any>;
        await insertRunEventRow(userId, {
          jobId: e.jobId ?? null,
          status: e.status ?? 'unknown',
          title: e.title ?? null,
          company: e.company ?? null,
          reason: e.reason ?? e.redirectedTo ?? e.error ?? null,
          url: e.url ?? null,
          ts: e.ts ?? new Date(),
          questions: normaliseQuestions(e.questions).slice(0, 30),
        });
        runEvents++;
      } catch {
        /* skip an unparsable line rather than aborting the whole sync */
      }
    }
  }

  return { applications, runEvents };
}
