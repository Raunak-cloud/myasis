import { isApplicationAiModel, type ApplicationAiModel } from '../src/application-ai-model.js';

export const APPLICATION_AI_MODEL_KEY = 'APPLICATION_AI_MODEL';
export const APPLICATION_AI_SELECTION_ERROR = 'Choose Celeris or Claude Haiku 5.5.';

/** An operator pilot is specific to an authenticated admin owner. This is
 * computed at worker launch and is not an editable per-account setting. */
export function applicationAiFormReadinessMode(
  userId: string,
  admin: boolean,
  model: ApplicationAiModel,
  env: Record<string, string | undefined>,
): 'standard' | 'agent-managed' {
  const owners = (env.ADMIN_HAIKU_AGENT_MANAGED_FORM_OWNERS ?? '').split(',').map(owner => owner.trim()).filter(Boolean);
  return admin && model === 'haiku' && /^[A-Za-z0-9_-]+$/.test(userId) && owners.includes(userId)
    ? 'agent-managed' : 'standard';
}

export function applicationAiSettingsError(
  updates: Record<string, unknown>,
  targetIsAdmin: boolean,
): { status: number; error: string } | null {
  if (!Object.hasOwn(updates, APPLICATION_AI_MODEL_KEY)) return null;
  if (!targetIsAdmin) return { status: 403, error: 'Application model selection is available only to administrator accounts.' };
  return isApplicationAiModel(updates[APPLICATION_AI_MODEL_KEY])
    ? null : { status: 400, error: APPLICATION_AI_SELECTION_ERROR };
}

/** An explicit invalid choice is an error, never a request to fall back. */
export function applicationAiModel(value: unknown): ApplicationAiModel {
  if (value === undefined) return 'celeris';
  if (!isApplicationAiModel(value)) throw new Error(APPLICATION_AI_SELECTION_ERROR);
  return value;
}

export function haikuConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim());
}

export function applicationAiConfigurationError(model: ApplicationAiModel, env: Record<string, string | undefined>, admin = false): string | null {
  if (model === 'haiku' && !haikuConfigured(env)) {
    return 'Claude Haiku 5.5 is not configured. Add an Anthropic or OpenRouter API key in Admin settings before starting a run.';
  }
  return model === 'celeris' && admin && !env.CELERIS_API_KEY?.trim()
    ? 'Celeris is not configured. Add a Celeris API key in Admin settings before starting a run.' : null;
}

/** Computed metadata is never accepted as an editable run setting. */
export function applicationAiSettingsMetadata(saved: Record<string, string>, admin: boolean, env: Record<string, string | undefined>): Record<string, string> {
  return admin
    ? {
      APPLICATION_AI_MODEL: saved.APPLICATION_AI_MODEL ?? 'celeris',
      APPLICATION_AI_HAIKU_CONFIGURED: String(haikuConfigured(env)),
      APPLICATION_AI_CELERIS_CONFIGURED: String(Boolean(env.CELERIS_API_KEY?.trim())),
    }
    : { APPLICATION_AI_MODEL: 'celeris' };
}
