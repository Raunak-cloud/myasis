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

export const assertApplicationBrowserConfigured = assertApplicationModelConfigured;
