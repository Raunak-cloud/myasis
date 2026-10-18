import { EMPLOYER_SOURCES, employerTargets, isEmployerSource } from '../../seek-bot/src/employer-source-config.js';
import { EMPLOYER_BROWSER_PROVIDERS } from '../../seek-bot/src/employer-browser-config.js';
import { applicationModelSettingsError, applicationModelForAccount } from './application-model-policy.js';

export function jobSourceSettingsError(updates: Record<string, unknown>, targetIsAdmin: boolean): { status: number; error: string } | null {
  const modelError = applicationModelSettingsError(updates, targetIsAdmin);
  if (modelError) return modelError;
  if (updates.EMPLOYER_BROWSER_PROVIDER !== undefined) {
    if (!targetIsAdmin) return { status: 403, error: 'Employer browser selection is available only to administrator accounts.' };
    if (!(EMPLOYER_BROWSER_PROVIDERS as readonly unknown[]).includes(updates.EMPLOYER_BROWSER_PROVIDER)) return { status: 400, error: 'Choose a supported employer browser.' };
  }
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
  settings.APPLICATION_AI_MODEL = applicationModelForAccount(settings.APPLICATION_AI_MODEL, targetIsAdmin);
  const allowed: string[] = ['seek', 'indeed', ...(targetIsAdmin ? EMPLOYER_SOURCES.map(source => source.id) : [])];
  const platforms = [...new Set((settings.PLATFORMS || 'seek').split(',').map(value => value.trim().toLowerCase()))].filter(value => allowed.includes(value));
  settings.PLATFORMS = platforms.join(',') || 'seek';
  settings.EMPLOYER_FEEDS_ADMIN_ENABLED = targetIsAdmin ? 'true' : 'false';
  settings.SMARTRECRUITERS_ADMIN_ENABLED = targetIsAdmin ? 'true' : 'false';
  settings.BRIGHTDATA_ADMIN_ENABLED = targetIsAdmin ? 'true' : 'false';
  settings.EMPLOYER_BROWSER_PROVIDER = targetIsAdmin ? settings.EMPLOYER_BROWSER_PROVIDER || 'local' : 'local';
  for (const source of EMPLOYER_SOURCES) settings[source.key] = targetIsAdmin ? employerTargets(source.id, settings[source.key] || source.defaults).join(',') : '';
}

export function availableJobSources(boards: string[], targetIsAdmin: boolean, signedIn: (board: 'seek' | 'indeed') => boolean) {
  const supported = boards.filter(board => board === 'seek' || board === 'indeed' || (isEmployerSource(board) && targetIsAdmin));
  const usable = supported.filter(board => isEmployerSource(board) || signedIn(board as 'seek' | 'indeed'));
  return { supported, usable, unavailable: supported.filter(board => !usable.includes(board)) };
}
