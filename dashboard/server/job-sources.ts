import { smartRecruitersCompanies, SMARTRECRUITERS_DEFAULT_COMPANIES } from '../../seek-bot/src/smartrecruiters.js';

export function jobSourceSettingsError(updates: Record<string, unknown>, targetIsAdmin: boolean): { status: number; error: string } | null {
  const selected = String(updates.PLATFORMS ?? '').split(',').map(value => value.trim().toLowerCase());
  if (!targetIsAdmin && (selected.includes('smartrecruiters') || updates.SMARTRECRUITERS_COMPANIES !== undefined)) {
    return { status: 403, error: 'SmartRecruiters is currently available only to administrator accounts.' };
  }
  if (updates.SMARTRECRUITERS_COMPANIES !== undefined) {
    try { smartRecruitersCompanies(String(updates.SMARTRECRUITERS_COMPANIES)); }
    catch (error) { return { status: 400, error: (error as Error).message }; }
  }
  return null;
}

/** Enforced again at execution, including old settings and scheduled/admin-triggered runs. */
export function applyJobSourceAccess(settings: Record<string, string>, targetIsAdmin: boolean): void {
  const allowed = targetIsAdmin ? ['seek', 'indeed', 'smartrecruiters'] : ['seek', 'indeed'];
  const platforms = [...new Set((settings.PLATFORMS || 'seek').split(',').map(value => value.trim().toLowerCase()))]
    .filter(value => allowed.includes(value));
  settings.PLATFORMS = platforms.join(',') || 'seek';
  // This flag is server-owned and explicitly overrides the shared environment for every account.
  settings.SMARTRECRUITERS_ADMIN_ENABLED = targetIsAdmin ? 'true' : 'false';
  settings.SMARTRECRUITERS_COMPANIES = targetIsAdmin
    ? smartRecruitersCompanies(settings.SMARTRECRUITERS_COMPANIES || SMARTRECRUITERS_DEFAULT_COMPANIES).join(',') : '';
}

/** Public feeds require admin access, while browser job boards require a confirmed sign-in. */
export function availableJobSources(boards: string[], targetIsAdmin: boolean, signedIn: (board: 'seek' | 'indeed') => boolean) {
  const supported = boards.filter(board => board === 'seek' || board === 'indeed' || (board === 'smartrecruiters' && targetIsAdmin));
  const usable = supported.filter(board => board === 'smartrecruiters' || signedIn(board as 'seek' | 'indeed'));
  return { supported, usable, unavailable: supported.filter(board => !usable.includes(board)) };
}
