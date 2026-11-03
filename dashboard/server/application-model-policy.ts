import { CUSTOMER_APPLICATION_MODEL, applicationModelLabel, isApplicationModel, type ApplicationModel } from '../../seek-bot/src/application-model-catalog.js';

/** Select the credential only after owner/model authorization. Never lend the
 * unused provider's key to a run or fall back when the selected key is absent. */
export function applicationModelCredentials(model: ApplicationModel, server: Readonly<Record<string,string|undefined>>): Record<string,string> {
  const openRouter = model !== 'celeris';
  const key = openRouter ? 'OPENROUTER_API_KEY' : 'CELERIS_API_KEY';
  const credential = server[key]?.trim();
  if (!credential) throw Error(`${openRouter ? applicationModelLabel(model) : 'Magnus job review'} is not configured. Add ${key} in Admin settings before starting a run.`);
  return { CELERIS_API_KEY: openRouter ? '' : credential, OPENROUTER_API_KEY: openRouter ? credential : '' };
}

export function applicationModelSettingsError(updates: Record<string, unknown>, admin: boolean): { status: number; error: string } | null {
  if (updates.APPLICATION_AI_MODEL === undefined) return null;
  if (!admin) return { status: 403, error: 'Model routing is managed by the server.' };
  return isApplicationModel(updates.APPLICATION_AI_MODEL) ? null
    : { status: 400, error: 'Choose an available run model.' };
}
/** Rechecked for the account owner at every start, including queued/scheduled work. */
export function applicationModelForAccount(value: unknown, admin: boolean): ApplicationModel {
  return admin && isApplicationModel(value) ? value : CUSTOMER_APPLICATION_MODEL;
}
