import { AsyncLocalStorage } from 'node:async_hooks';
import { CUSTOMER_APPLICATION_MODEL, JOB_REVIEW_MODEL, OPENROUTER_APPLICATION_MODELS, isApplicationModel } from './application-model-catalog.js';

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
export function applicationModelIdentity(env: ApplicationEnvironment = applicationModelEnvironment()) {
  // The server authorizes this immutable run selection against the active owner.
  // Normal customer environments remain pinned to Magnus.
  const selection = isApplicationModel(env.APPLICATION_AI_MODEL) ? env.APPLICATION_AI_MODEL : CUSTOMER_APPLICATION_MODEL;
  return selection !== 'celeris'
    ? { selection, model: OPENROUTER_APPLICATION_MODELS[selection].model, protocol: 'openrouter-chat-v1', provider: 'OpenRouter' } as const
    : { selection: 'celeris', model: 'celeris', protocol: 'celeris-chat-v1', provider: 'Celeris' } as const;
}

export function applicationModelAvailable(env: ApplicationEnvironment = applicationModelEnvironment()): boolean {
  return Boolean((applicationModelIdentity(env).provider === 'OpenRouter' ? env.OPENROUTER_API_KEY : env.CELERIS_API_KEY)?.trim());
}

export function assertApplicationModelConfigured(env: ApplicationEnvironment = applicationModelEnvironment()): void {
  if (!applicationModelAvailable(env)) throw new Error(`${applicationModelIdentity(env).provider === 'OpenRouter' ? 'OPENROUTER_API_KEY' : 'CELERIS_API_KEY'} is required for application AI.`);
}

export const MINIMAX_APPLICATION_MODEL = OPENROUTER_APPLICATION_MODELS.minimax.model;

/** Account authorization and credential selection happen in the dashboard. */
export function applicationAgentIdentity(env: ApplicationEnvironment = applicationModelEnvironment()) {
  const identity = applicationModelIdentity(env);
  return identity.provider === 'OpenRouter'
    ? identity
    : { selection: 'celeris', model: 'celeris-1-magnus', protocol: 'celeris-chat-v1', provider: 'Celeris' } as const;
}

export function assertApplicationBrowserConfigured(env: ApplicationEnvironment = applicationModelEnvironment()): void {
  assertReviewModelConfigured(env);
  assertApplicationModelConfigured(env);
}

/** Ranking and fit have their own identity, independent of the applying agent. */
export function reviewModelIdentity() {
  return { role: 'job-review', model: JOB_REVIEW_MODEL, protocol: 'openrouter-json-object-v1', provider: 'OpenRouter', reasoning: false } as const;
}

export function jobReviewCredential(env: ApplicationEnvironment = applicationModelEnvironment()): string | undefined {
  return env.OPENROUTER_JOB_REVIEW_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
}
export function reviewModelAvailable(env: ApplicationEnvironment = applicationModelEnvironment()): boolean {
  return Boolean(jobReviewCredential(env));
}
export function assertReviewModelConfigured(env: ApplicationEnvironment = applicationModelEnvironment()): void {
  if (!reviewModelAvailable(env)) throw new Error('OPENROUTER_API_KEY is required for job ranking and review.');
}
