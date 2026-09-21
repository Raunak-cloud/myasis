/**
 * Featherless serves the rewriting model through its authenticated chat API.
 * There is one endpoint and no alternate provider: when a rewrite cannot be
 * served, the grounded draft is sent instead. The bot and the dashboard
 * (which loads it from dist) both go through it, so a run's start-up check, the
 * admin health page and the Rewrite tab can never disagree about whether the
 * humanizer is up. It reads no config of its own: callers pass the endpoint.
 */

export interface HumanizerEndpoint {
  /** Root of the server, without `/v1` or a trailing slash. */
  base: string;
  /** Present for a hosted API. */
  apiKey?: string;
  model: string;
}

interface EnvLike {
  HUMANIZER_URL?: string;
  HUMANIZER_API_KEY?: string;
  HUMANIZER_MODEL?: string;
}

const clean = (url: string | undefined) => (url ?? '').trim().replace(/\/(v1\/?)?$/, '');

/** The configured endpoint, or null when the humanizer has no URL. */
export function humanizerEndpoint(env: EnvLike): HumanizerEndpoint | null {
  const base = clean(env.HUMANIZER_URL);
  if (!base) return null;
  return {
    base,
    apiKey: env.HUMANIZER_API_KEY?.trim() || undefined,
    model: env.HUMANIZER_MODEL?.trim() || 'authormist/authormist-originality',
  };
}

/**
 * Named, because Featherless answers Node's default `User-Agent: node` on its
 * model route with "404 Gone" — which read here as "the provider does not
 * serve this model" for a model it was serving.
 */
const headers = (endpoint: HumanizerEndpoint): Record<string, string> => ({
  'Content-Type': 'application/json',
  'User-Agent': 'seek-bot-humanizer/1.0',
  ...(endpoint.apiKey && { Authorization: `Bearer ${endpoint.apiKey}` }),
});

export interface Readiness {
  ready: boolean;
  /** One phrase an operator can act on. */
  detail: string;
}

/**
 * Whether a rewrite sent now would be served.
 *
 * For a hosted API that is one request: the model's own record answers 401 for
 * a bad key, 404 for a model the provider does not carry, and otherwise says
 * whether the model is warm. A cold model takes minutes to load, so it counts
 * as not ready rather than as something to wait for.
 */
export async function probeHumanizer(endpoint: HumanizerEndpoint, timeoutMs = 5_000): Promise<Readiness> {
  try {
    if (!endpoint.apiKey) return { ready: false, detail: 'the Featherless API key is not configured' };
    const response = await fetch(`${endpoint.base}/v1/models/${encodeURIComponent(endpoint.model)}`, {
      headers: headers(endpoint),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return { ready: false, detail: 'the API key was refused' };
    if (response.status === 404) return { ready: false, detail: `the provider does not serve "${endpoint.model}"` };
    if (!response.ok) return { ready: false, detail: `model check returned HTTP ${response.status}` };
    const tier = ((await response.json()) as { availability?: { tier?: string } }).availability?.tier;
    // Providers without a warm/cold notion say nothing, which means always on.
    return !tier || tier === 'warm'
      ? { ready: true, detail: 'model warm' }
      : { ready: false, detail: `the model is ${tier}; it has to be warm to answer` };
  } catch (error) {
    return { ready: false, detail: (error as Error).message };
  }
}

/**
 * Sampling that a request leaves out is filled in by the server, and servers
 * disagree: llama.cpp cuts to the 40 likeliest tokens and drops any under 5% of
 * the top one, while a hosted vLLM-style API applies neither. The rewriting
 * prompts and their validation were tuned against llama.cpp, so its defaults
 * are sent explicitly and the same request samples the same way anywhere.
 */
const SAMPLING_DEFAULTS = { top_k: 40, min_p: 0.05, repetition_penalty: 1, presence_penalty: 0, frequency_penalty: 0 };

/** Over the plan's concurrency, or the provider is briefly out of capacity: both clear by themselves. */
const RETRYABLE = new Set([429, 500, 503]);
const MAX_RETRIES = 3;

/**
 * One chat completion, retried while the refusal is the kind that passes.
 *
 * Featherless counts requests in flight against the plan and answers 429 above
 * it; with several accounts applying at once that is normal, not a fault, and a
 * couple of seconds later there is room. 503 is documented as worth three
 * tries. Everything else — a bad key, a cold model, a malformed request — is
 * returned as it is for the caller to report. Network errors are thrown.
 */
export async function chatCompletion(
  endpoint: HumanizerEndpoint,
  body: Record<string, unknown>,
  deadline: number,
): Promise<Response> {
  if (!endpoint.apiKey) throw new Error('The Featherless API key is not configured.');
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${endpoint.base}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(endpoint),
      body: JSON.stringify({ ...SAMPLING_DEFAULTS, ...body, model: endpoint.model, stream: false }),
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });
    const wait = 1_500 * (attempt + 1);
    if (!RETRYABLE.has(response.status) || attempt >= MAX_RETRIES || Date.now() + wait >= deadline) return response;
    await response.arrayBuffer().catch(() => {}); // release the connection before waiting
    await new Promise(done => setTimeout(done, wait));
  }
}
