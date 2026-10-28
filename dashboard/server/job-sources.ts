import { EMPLOYER_SOURCES, employerTargets, isEmployerSource } from '../../seek-bot/src/employer-source-config.js';
import { RETIRED_SOURCE_SETTING_KEYS } from '../../seek-bot/src/retired-job-sources.js';
import { applicationModelSettingsError, applicationModelForAccount } from './application-model-policy.js';
import { applicationAgentSettingsError, applicationAgentModeForAccount, applicationScreenshotsForAccount } from './application-agent-policy.js';

export function jobSourceSettingsError(updates: Record<string, unknown>, targetIsAdmin: boolean): { status: number; error: string } | null {
  const modelError = applicationModelSettingsError(updates, targetIsAdmin);
  if (modelError) return modelError;
  const agentError = applicationAgentSettingsError(updates, targetIsAdmin);
  if (agentError) return agentError;
  const selected = String(updates.PLATFORMS ?? '').split(',').map(value => value.trim().toLowerCase());
  if (updates.PLATFORMS !== undefined && selected.some(id => id && !['seek', 'indeed'].includes(id) && !isEmployerSource(id))) return { status: 400, error: 'Choose an available job source.' };
  if (!targetIsAdmin && (selected.some(isEmployerSource) || EMPLOYER_SOURCES.some(source => updates[source.key] !== undefined))) {
    return { status: 403, error: 'Employer feeds are currently available only to administrator accounts.' };
  }
  for (const source of EMPLOYER_SOURCES) {
    if (updates[source.key] === undefined) continue;
    try { if (!employerTargets(source.id, String(updates[source.key])).length) return { status: 400, error: 'Choose an available employer career site.' }; }
    catch (error) { return { status: 400, error: (error as Error).message }; }
  }
  return null;
}

/** Account access wins over saved choices, client overrides and shared process environment. */
export function applyJobSourceAccess(settings: Record<string, string>, targetIsAdmin: boolean): void {
  for (const key of RETIRED_SOURCE_SETTING_KEYS) delete settings[key];
  settings.APPLICATION_AI_MODEL = applicationModelForAccount(settings.APPLICATION_AI_MODEL, targetIsAdmin);
  settings.APPLICATION_AGENT_MODE = applicationAgentModeForAccount(settings.APPLICATION_AGENT_MODE, targetIsAdmin);
  settings.APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN = applicationScreenshotsForAccount(settings.APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN, targetIsAdmin);
  // Authorization is supplied only by accountApplicationEnvironment after rechecking ownership.
  delete settings.APPLICATION_AGENT_MODE_AUTHORIZED;
  const allowed: string[] = ['seek', 'indeed', ...(targetIsAdmin ? EMPLOYER_SOURCES.map(source => source.id) : [])];
  const platforms = [...new Set((settings.PLATFORMS || 'seek').split(',').map(value => value.trim().toLowerCase()))].filter(value => allowed.includes(value));
  settings.PLATFORMS = platforms.join(',') || 'seek';
  settings.EMPLOYER_FEEDS_ADMIN_ENABLED = targetIsAdmin ? 'true' : 'false';
  settings.SMARTRECRUITERS_ADMIN_ENABLED = targetIsAdmin ? 'true' : 'false';
  for (const source of EMPLOYER_SOURCES) {
    settings[source.key] = targetIsAdmin ? employerTargets(source.id, settings[source.key] || source.defaults).join(',') : '';
    if (targetIsAdmin && !settings[source.key]) settings.PLATFORMS = settings.PLATFORMS.split(',').filter(id => id !== source.id).join(',');
  }
}

export function availableJobSources(boards: string[], targetIsAdmin: boolean, signedIn: (board: 'seek' | 'indeed') => boolean) {
  const supported = boards.filter(board => board === 'seek' || board === 'indeed' || (isEmployerSource(board) && targetIsAdmin));
  const usable = supported.filter(board => isEmployerSource(board) || signedIn(board as 'seek' | 'indeed'));
  return { supported, usable, unavailable: supported.filter(board => !usable.includes(board)) };
}
