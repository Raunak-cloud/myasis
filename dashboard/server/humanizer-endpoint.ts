import { readEnv } from './runner.js';

/**
 * seek-bot's own knowledge of how to reach the rewriting model, loaded from
 * its compiled output. The run's start-up check, the admin health page and the
 * Rewrite tab all ask the same module the bot itself uses, so none of them can
 * call the humanizer up while a run finds it down — or carry a second idea of
 * how a hosted API differs from a local llama.cpp.
 */
export interface HumanizerEndpoint {
  base: string;
  apiKey?: string;
  model: string;
}

interface EndpointModule {
  humanizerEndpoint(env: Record<string, string | undefined>): HumanizerEndpoint | null;
  probeHumanizer(endpoint: HumanizerEndpoint, timeoutMs?: number): Promise<{ ready: boolean; detail: string }>;
  chatCompletion(endpoint: HumanizerEndpoint, body: Record<string, unknown>, deadline: number): Promise<Response>;
}

const load = (): Promise<EndpointModule> =>
  import(/* @vite-ignore */ new URL('../../seek-bot/dist/humanizer-endpoint.js', import.meta.url).href);

const KEYS = ['HUMANIZER_URL', 'HUMANIZER_API_KEY', 'HUMANIZER_MODEL'] as const;

/** The configured endpoint, with the precedence a run sees: its overrides, then the server process, then seek-bot/.env. */
export async function humanizerEndpoint(overrides: Record<string, string> = {}): Promise<HumanizerEndpoint | null> {
  const file = readEnv();
  const settings = Object.fromEntries(KEYS.map((key) => [key, overrides[key] ?? process.env[key] ?? file[key]]));
  return (await load()).humanizerEndpoint(settings);
}

export async function probeHumanizer(endpoint: HumanizerEndpoint, timeoutMs?: number) {
  return (await load()).probeHumanizer(endpoint, timeoutMs);
}

export async function chatCompletion(endpoint: HumanizerEndpoint, body: Record<string, unknown>, deadline: number) {
  return (await load()).chatCompletion(endpoint, body, deadline);
}
