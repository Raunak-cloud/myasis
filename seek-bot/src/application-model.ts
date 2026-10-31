import { AsyncLocalStorage } from 'node:async_hooks';

type ApplicationEnvironment = Readonly<Record<string, string | undefined>>;
const contexts = new AsyncLocalStorage<ApplicationEnvironment>();

/** Workers use their own environment; shared dashboard helpers use an
 * immutable request snapshot so credentials and account data never leak
 * through a process-wide environment mutation. */
export const applicationModelEnvironment = (): ApplicationEnvironment => contexts.getStore() ?? process.env;

export function withApplicationModel<T>(env: ApplicationEnvironment, work: () => T): T {
  return contexts.run(Object.freeze({ ...env }), work);
}

/** Stable provider identity also separates established caches from retired
 * experiments without deleting account history. */
export function applicationModelIdentity(_env?: ApplicationEnvironment) {

  return { selection: 'celeris', model: 'celeris', protocol: 'celeris-chat-v1', provider: 'Celeris' } as const;
}

export function applicationModelAvailable(env: ApplicationEnvironment = applicationModelEnvironment()): boolean {
  return Boolean(env.CELERIS_API_KEY?.trim());
}

export function assertApplicationModelConfigured(env: ApplicationEnvironment = applicationModelEnvironment()): void {
  if (!applicationModelAvailable(env)) throw new Error('CELERIS_API_KEY is required for application AI.');
}

export const MINIMAX_APPLICATION_MODEL = 'minimax/minimax-m3.1-flash';

/** The applying agent is selectable independently of the Celeris matcher.
 * Account authorization and credential selection happen in the dashboard. */
export function applicationAgentIdentity(env: ApplicationEnvironment = applicationModelEnvironment()) {
  return env.APPLICATION_AI_MODEL === 'minimax'
    ? { selection: 'minimax', model: MINIMAX_APPLICATION_MODEL, protocol: 'openrouter-chat-v1', provider: 'OpenRouter' } as const
    : { selection: 'celeris', model: 'celeris-1-magnus', protocol: 'celeris-chat-v1', provider: 'Celeris' } as const;
}

export function assertApplicationBrowserConfigured(env: ApplicationEnvironment = applicationModelEnvironment()): void {
  if (applicationAgentIdentity(env).selection === 'minimax') {
    if (!env.OPENROUTER_API_KEY?.trim()) throw new Error('OPENROUTER_API_KEY is required for the MiniMax application agent.');
  } else assertApplicationModelConfigured(env);
}
