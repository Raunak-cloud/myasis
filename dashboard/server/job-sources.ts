import { EMPLOYER_SOURCES, employerTargets, isEmployerSource } from '../../seek-bot/src/employer-source-config.js';

export function jobSourceSettingsError(updates: Record<string, unknown>, targetIsAdmin: boolean): { status: number; error: string } | null {
  const selected = String(updates.PLATFORMS ?? '').split(',').map(value => value.trim().toLowerCase());
  if (!targetIsAdmin && (selected.some(isEmployerSource) || EMPLOYER_SOURCES.some(source => updates[source.key] !== undefined))) {
    return { status: 403, error: 'Employer feeds are currently available only to administrator accounts.' };
  }
  for (const source of EMPLOYER_SOURCES) {
    if (updates[source.key] === undefined) continue;
    try { employerTargets(source.id, String(updates[source.key])); }
    catch (error) { return { status: 400, error: (error as Error).message }; }
  }
  return null;
}

/** Account access wins over saved choices, client overrides and shared process environment. */
export function applyJobSourceAccess(settings: Record<string, string>, targetIsAdmin: boolean): void {
  const allowed: string[] = ['seek', 'indeed', ...(targetIsAdmin ? EMPLOYER_SOURCES.map(source => source.id) : [])];
  const platforms = [...new Set((settings.PLATFORMS || 'seek').split(',').map(value => value.trim().toLowerCase()))].filter(value => allowed.includes(value));
  settings.PLATFORMS = platforms.join(',') || 'seek';
  settings.EMPLOYER_FEEDS_ADMIN_ENABLED = targetIsAdmin ? 'true' : 'false';
  settings.SMARTRECRUITERS_ADMIN_ENABLED = targetIsAdmin ? 'true' : 'false';
  for (const source of EMPLOYER_SOURCES) settings[source.key] = targetIsAdmin ? employerTargets(source.id, settings[source.key] || source.defaults).join(',') : '';
}

export function availableJobSources(boards: string[], targetIsAdmin: boolean, signedIn: (board: 'seek' | 'indeed') => boolean) {
  const supported = boards.filter(board => board === 'seek' || board === 'indeed' || (isEmployerSource(board) && targetIsAdmin));
  const usable = supported.filter(board => isEmployerSource(board) || signedIn(board as 'seek' | 'indeed'));
  return { supported, usable, unavailable: supported.filter(board => !usable.includes(board)) };
}
