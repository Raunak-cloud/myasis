import { listResumes } from './files.js';
import { profileGaps } from './profile.js';
import { loadUserSettings } from './settings.js';

interface SetupCheck {
  id: string;
  label: string;
  done: boolean;
  /** Shown when incomplete — says what to do, not just what is wrong. */
  hint: string;
  /** Which Setup section fixes it, or 'external' for things outside the app. */
  fix: 'details' | 'documents' | 'looking' | 'where' | 'external';
  required: boolean;
}

/**
 * Is this account actually ready to run?
 *
 * A new user cannot tell whether a disappointing run means "nothing matched"
 * or "you never uploaded a résumé". Each check is phrased as the next action,
 * and ordered by how much it unblocks. Scoped to one account: résumés,
 * knowledge, profile and search settings (KEYWORDS/ONSITE_CITY/
 * WORK_ARRANGEMENTS) are all per-user. Installation health is reported
 * elsewhere and must never make a brand-new account look partly complete.
 */
/**
 * The steps only the account holder can do: résumé, details, search terms,
 * location. Until they are done there is nothing to apply with, so the
 * scheduler waits for them rather than trying and failing every minute — a
 * new account has not had a run fail, it has not finished setting up.
 */
export async function accountSetupChecks(userId: string): Promise<{
  resume: SetupCheck;
  profile: SetupCheck;
  keywords: SetupCheck;
  where: SetupCheck;
}> {
  const [resumes, gaps, settings] = await Promise.all([
    listResumes(userId),
    profileGaps(userId),
    loadUserSettings(userId),
  ]);
  return {
    resume: {
      id: 'resume',
      label: 'Résumé uploaded',
      done: resumes.length > 0,
      hint: 'Upload your résumé first. We will use it to fill in the details it contains.',
      fix: 'documents',
      required: true,
    },
    profile: {
      id: 'profile',
      label: 'Remaining details completed',
      done: gaps.length === 0,
      hint: gaps.length
        ? `Still needed after résumé import: ${gaps.join(', ')}.`
        : 'Name, contact, work rights and experience are set.',
      fix: 'details',
      required: true,
    },
    keywords: {
      id: 'keywords',
      label: 'Search terms set',
      done: Boolean(settings.KEYWORDS?.trim()),
      hint: 'Add the job titles to search for, comma separated.',
      fix: 'looking',
      required: true,
    },
    where: {
      id: 'where',
      label: 'Location and pay set',
      done: Boolean(settings.ONSITE_CITY?.trim()) && Boolean(settings.WORK_ARRANGEMENTS?.trim()),
      hint: 'Choose remote/hybrid/on-site and your city so on-site roles are filtered correctly.',
      fix: 'where',
      required: true,
    },
  };
}

/** Whether the account holder has done everything only they can do. */
export async function accountSetupComplete(userId: string): Promise<boolean> {
  const checks = await accountSetupChecks(userId);
  return Object.values(checks).every((check) => !check.required || check.done);
}

export async function setupStatus(
  userId: string,
): Promise<{ checks: SetupCheck[]; ready: boolean; done: number; total: number }> {
  const account = await accountSetupChecks(userId);
  const checks: SetupCheck[] = [
    account.resume,
    account.profile,
    account.keywords,
    account.where,
  ];

  const required = checks.filter((c) => c.required);
  return {
    checks,
    ready: required.every((c) => c.done),
    done: checks.filter((c) => c.done).length,
    total: checks.length,
  };
}
