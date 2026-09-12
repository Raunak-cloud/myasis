import { assertHumanizerHealthy, readEnv } from './runner.js';
import { listResumes, listKnowledge } from './files.js';
import { loadAttention } from './attention.js';
import { profileGaps } from './profile.js';
import { loadUserSettings } from './settings.js';

export interface SetupCheck {
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
 * WORK_ARRANGEMENTS) are all per-user now — only the matching-service key and
 * the humanizer are genuinely install-wide, so those two still come from
 * `readEnv()`.
 */
export async function setupStatus(
  userId: string,
): Promise<{ checks: SetupCheck[]; ready: boolean; done: number; total: number }> {
  const env = readEnv();
  const [resumes, knowledgeAll, attention, gaps, settings] = await Promise.all([
    listResumes(userId),
    listKnowledge(userId),
    loadAttention(userId),
    profileGaps(userId),
    loadUserSettings(userId),
  ]);
  const knowledge = knowledgeAll.filter((k) => k.enabled);

  // If listings are actively blocked on work rights, verification is unfinished.
  const blockedOnVerification = attention.filter((a) => a.kind === 'verification').length;

  let humanizerError = '';
  try {
    await assertHumanizerHealthy();
  } catch (error) {
    humanizerError = (error as Error).message;
  }

  const checks: SetupCheck[] = [
    {
      id: 'profile',
      label: 'Your details completed',
      done: gaps.length === 0,
      hint: gaps.length
        ? `Still needed: ${gaps.join(', ')}. These answer questions on nearly every application.`
        : 'Name, contact, work rights and experience are set.',
      fix: 'details',
      required: true,
    },
    {
      id: 'key',
      label: 'Matching service connected',
      done: Boolean(env.GEMINI_API_KEY),
      hint: 'Without it, jobs are matched on keywords alone and the shortlist is unfiltered.',
      fix: 'looking',
      required: true,
    },
    {
      id: 'humanizer',
      label: 'Writing assistant ready',
      done: !humanizerError,
      hint: humanizerError
        ? 'The writing assistant is temporarily unavailable. Please try again shortly.'
        : 'Ready to prepare application writing.',
      fix: 'external',
      required: true,
    },
    {
      id: 'resume',
      label: 'Résumé uploaded',
      done: resumes.length > 0,
      hint: 'Upload the résumé you want attached to applications.',
      fix: 'documents',
      required: true,
    },
    {
      id: 'keywords',
      label: 'Search terms set',
      done: Boolean(settings.KEYWORDS?.trim()),
      hint: 'Add the job titles to search for, comma separated.',
      fix: 'looking',
      required: true,
    },
    {
      id: 'where',
      label: 'Location and pay set',
      done: Boolean(settings.ONSITE_CITY?.trim()) && Boolean(settings.WORK_ARRANGEMENTS?.trim()),
      hint: 'Choose remote/hybrid/on-site and your city so on-site roles are filtered correctly.',
      fix: 'where',
      required: true,
    },
    {
      id: 'knowledge',
      label: 'Personal details added',
      done: knowledge.length > 0,
      hint: 'Add your CV or notes so screening questions can be answered instead of halting the run.',
      fix: 'documents',
      required: false,
    },
    {
      id: 'workrights',
      label: 'Work rights verified on SEEK',
      done: blockedOnVerification === 0,
      hint:
        blockedOnVerification > 0
          ? `${blockedOnVerification} listings are blocked waiting for this. Complete SEEK Pass once on your SEEK profile to unlock them.`
          : 'Complete SEEK Pass on your SEEK profile if listings start asking for it.',
      fix: 'external',
      required: false,
    },
  ];

  const required = checks.filter((c) => c.required);
  return {
    checks,
    ready: required.every((c) => c.done),
    done: checks.filter((c) => c.done).length,
    total: checks.length,
  };
}
