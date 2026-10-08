import { one } from './db/index.js';
import { autofillProfileFromResume } from './profile-autofill.js';
import { loadProfile, saveProfile } from './profile.js';
import { loadUserSettings, saveUserSettings } from './settings.js';
import { generateSearchTerms } from './search-terms.js';

/**
 * One upload sets the account up.
 *
 * Setup asked a new candidate for five things before the first application:
 * a resume, a details form, job titles, a city and work style, and a job
 * board. Four of those are already in the resume or the sign-in, so the
 * upload fills them — the details from the document, the email from the
 * Google account, job titles suggested from the resume, the city from the
 * address — and what is left for the person is to glance over them and
 * connect a board. Onboarding research is consistent that time to first
 * value decides activation; typing what a document already says is the
 * friction that loses people.
 *
 * The one rule: only what is still empty is filled. Anything the person set
 * themselves is left exactly as it is, so uploading a second resume never
 * undoes a choice.
 */

/** The capital a candidate in each state most likely means by "my city". */
const STATE_CITY: Record<string, string> = {
  NSW: 'Sydney', VIC: 'Melbourne', QLD: 'Brisbane', WA: 'Perth',
  SA: 'Adelaide', TAS: 'Hobart', ACT: 'Canberra', NT: 'Darwin',
};

/** Work arrangements considered until the person narrows them: all of them. */
const ALL_ARRANGEMENTS = 'remote,hybrid,onsite';

export interface QuickSetupResult {
  /** Profile fields filled, by key. */
  filled: string[];
  /** Job titles added, when the account had none. */
  terms: string[];
  /** City chosen from the address, when the account had none. */
  city: string | null;
  /** Why the resume could not be read, when it could not. */
  error?: string;
}

export async function setUpFromResume(userId: string, resumeId?: string): Promise<QuickSetupResult> {
  const autofill = await autofillProfileFromResume(userId, resumeId)
    .catch((error): { ok: false; filled: string[]; error: string } => ({ ok: false, filled: [], error: (error as Error).message }));
  const filled = [...autofill.filled];

  // The address they signed in with is the one they check; a resume may carry an old one.
  const profile = await loadProfile(userId);
  if (!profile.email.trim()) {
    const account = await one<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    if (account?.email) {
      await saveProfile(userId, { email: account.email });
      filled.push('email');
    }
  }

  const settings = await loadUserSettings(userId);
  const updates: Record<string, string> = {};
  let terms: string[] = [];
  if (!settings.KEYWORDS?.trim()) {
    const generated = await generateSearchTerms(userId, { resumeIds: resumeId ? [resumeId] : undefined }).catch(() => null);
    if (generated?.ok && generated.terms?.length) {
      terms = generated.terms;
      updates.KEYWORDS = terms.join(', ');
    }
  }

  let city: string | null = null;
  if (!settings.ONSITE_CITY?.trim()) {
    const latest = await loadProfile(userId);
    city = STATE_CITY[latest.state.trim().toUpperCase()] ?? null;
    if (city) updates.ONSITE_CITY = city;
  }
  if (!settings.WORK_ARRANGEMENTS?.trim()) updates.WORK_ARRANGEMENTS = ALL_ARRANGEMENTS;

  if (Object.keys(updates).length) await saveUserSettings(userId, updates);
  return { filled, terms, city, ...(autofill.ok ? {} : { error: autofill.error }) };
}
