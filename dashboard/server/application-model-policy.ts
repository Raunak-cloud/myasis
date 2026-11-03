import { CUSTOMER_APPLICATION_MODEL, isApplicationModel, type ApplicationModel } from '../../seek-bot/src/application-model-catalog.js';

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
