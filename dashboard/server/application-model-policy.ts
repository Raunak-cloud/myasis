import { isApplicationModel, type ApplicationModel } from '../../seek-bot/src/application-model-catalog.js';

export function applicationModelSettingsError(updates: Record<string, unknown>, admin: boolean): { status: number; error: string } | null {
  if (updates.APPLICATION_AI_MODEL === undefined) return null;
  if (!admin) return { status: 403, error: 'Application model selection is available only to administrators.' };
  if (!isApplicationModel(updates.APPLICATION_AI_MODEL)) return { status: 400, error: 'Choose Celeris Magnus, MiniMax M3.1 or Qwen 3.7 Flash.' };
  return null;
}

/** Execution-time enforcement also covers stale saved settings and auto runs. */
export function applicationModelForAccount(value: unknown, admin: boolean): ApplicationModel {
  return admin && isApplicationModel(value) ? value : 'celeris';
}
