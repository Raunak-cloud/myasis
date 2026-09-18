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
  humanizerEndpoints(env: Record<string, string | undefined>): HumanizerEndpoint[];
  probeHumanizer(endpoint: HumanizerEndpoint, timeoutMs?: number): Promise<{ ready: boolean; detail: string }>;
  chatCompletion(endpoint: HumanizerEndpoint, body: Record<string, unknown>, deadline: number): Promise<Response>;
}

const load = (): Promise<EndpointModule> =>
  import(/* @vite-ignore */ new URL('../../seek-bot/dist/humanizer-endpoint.js', import.meta.url).href);

const KEYS = ['HUMANIZER_URL', 'HUMANIZER_FALLBACK_URL', 'HUMANIZER_API_KEY', 'HUMANIZER_MODEL'] as const;

/** The same precedence a run sees: its overrides, then the server process, then seek-bot/.env. */
function settings(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  const file = readEnv();
  return Object.fromEntries(KEYS.map((key) => [key, overrides[key] ?? process.env[key] ?? file[key]]));
}

export async function humanizerEndpoints(overrides?: Record<string, string>): Promise<HumanizerEndpoint[]> {
  return (await load()).humanizerEndpoints(settings(overrides));
}

export async function probeHumanizer(endpoint: HumanizerEndpoint, timeoutMs?: number) {
  return (await load()).probeHumanizer(endpoint, timeoutMs);
}

export async function chatCompletion(endpoint: HumanizerEndpoint, body: Record<string, unknown>, deadline: number) {
  return (await load()).chatCompletion(endpoint, body, deadline);
}

/**
 * The endpoint to use right now, preferring the first that is ready. Cached
 * briefly so a chunked document does not probe once per paragraph, but short
 * enough that an endpoint that drops is noticed in seconds.
 */
let cached: { endpoint: HumanizerEndpoint; until: number } | null = null;

export async function currentHumanizerEndpoint(): Promise<HumanizerEndpoint | null> {
  const candidates = await humanizerEndpoints();
  if (candidates.length <= 1) return candidates[0] ?? null;
  if (cached && Date.now() < cached.until) return cached.endpoint;
  for (const candidate of candidates) {
    if ((await probeHumanizer(candidate, 2_500)).ready) {
      cached = { endpoint: candidate, until: Date.now() + 30_000 };
      return candidate;
    }
  }
  cached = null;
  return candidates[0];
}

/** Forget the cached endpoint once it has failed a real request. */
export function forgetHumanizerEndpoint(): void {
  cached = null;
}
