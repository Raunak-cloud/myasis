import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

/** One process-scoped choice for every AI operation in an application run. */
export type ApplicationModel = 'celeris' | 'haiku';
type Environment = Record<string, string | undefined>;
const botRoot = fileURLToPath(new URL('../', import.meta.url));
const contexts = new AsyncLocalStorage<Environment>();
export const applicationModelEnvironment = (): Environment => contexts.getStore() ?? process.env;
/** Dashboard helpers share a process: selection must stay inside the request,
 * never in a mutated global environment that another account could inherit. */
export function withApplicationModel<T>(env: Environment, work: () => T): T {
  return contexts.run({ ...env }, work);
}

export function applicationModel(env: Environment = applicationModelEnvironment(), root = botRoot): ApplicationModel {
  const selected = env.APPLICATION_AI_MODEL ?? 'celeris';
  if (selected !== 'celeris' && selected !== 'haiku') throw new Error('Unsupported application AI model. Choose Celeris or Claude Haiku 5.5.');
  if (selected === 'haiku') {
    const owner = env.APPLICATION_AI_OWNER_ID;
    if (env.APPLICATION_AI_ADMIN_ENABLED !== 'true' || !owner || !/^[a-zA-Z0-9_-]+$/.test(owner)
      || !env.DATA_DIR || resolve(env.DATA_DIR) !== resolve(root, 'data', 'users', owner)) {
      throw new Error('Claude Haiku 5.5 requires an authenticated admin application run and its own account directory.');
    }
  }
  return selected;
}

export function applicationModelIdentity(env: Environment = applicationModelEnvironment(), root = botRoot) {
  const selection = applicationModel(env, root);
  return selection === 'haiku'
    ? { selection, model: 'claude-haiku-5-5', protocol: 'anthropic-messages-v1', provider: env.ANTHROPIC_API_KEY?.trim() ? 'Anthropic' : 'OpenRouter' }
    : { selection, model: 'celeris', protocol: 'celeris-chat-v1', provider: 'Celeris' };
}

export function applicationModelAvailable(env: Environment = applicationModelEnvironment(), root = botRoot): boolean {
  return applicationModel(env, root) === 'haiku'
    ? Boolean(env.ANTHROPIC_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim())
    : Boolean(env.CELERIS_API_KEY?.trim());
}

export function assertApplicationModelConfigured(env: Environment = applicationModelEnvironment(), root = botRoot): void {
  if (applicationModelAvailable(env, root)) return;
  throw new Error(applicationModel(env, root) === 'haiku'
    ? 'Claude Haiku 5.5 is selected but ANTHROPIC_API_KEY or OPENROUTER_API_KEY is not configured. No other model will be used.'
    : 'CELERIS_API_KEY is required for the selected Celeris model.');
}

/** Application browser runs use Anthropic's dated native browser toolset.
 * OpenRouter can still serve ordinary Messages calls, but its current route
 * rejected that declaration in the compatibility preflight. Check before
 * discovery/AI spending, rather than failing only after jobs are reviewed. */
export function assertApplicationBrowserConfigured(env: Environment = applicationModelEnvironment(), root = botRoot): void {
  assertApplicationModelConfigured(env, root);
  if (applicationModel(env, root) === 'haiku' && !env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error('Haiku native browser tools require a direct ANTHROPIC_API_KEY. The current OpenRouter connection does not support this browser run. No custom-tool or model fallback will be used.');
  }
}

export function applicationHaikuRoute(env: Environment = applicationModelEnvironment(), root = botRoot) {
  if (applicationModel(env, root) !== 'haiku') throw new Error('Haiku is not selected for this run.');
  assertApplicationModelConfigured(env, root);
  return env.ANTHROPIC_API_KEY?.trim()
    ? { provider: 'Anthropic' as const, apiKey: env.ANTHROPIC_API_KEY.trim(), endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-5-5' }
    : { provider: 'OpenRouter' as const, apiKey: env.OPENROUTER_API_KEY!.trim(), endpoint: 'https://openrouter.ai/api/v1/messages', model: 'anthropic/claude-haiku-5.5' };
}
