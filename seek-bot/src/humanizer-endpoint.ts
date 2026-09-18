/**
 * Talking to whatever serves the rewriting model.
 *
 * Two kinds of server speak the same OpenAI chat API here and differ in
 * everything around it:
 *
 *  - a hosted API (Featherless, https://featherless.ai/docs): a bearer key, no
 *    `/health`, a model that can be warm or cold, and a plan that refuses work
 *    over its concurrency with 429;
 *  - a local llama.cpp `llama-server`: no key, `/health`, one model always loaded.
 *
 * A key is what tells them apart — a keyed endpoint is a hosted one. This
 * module is the only place that knows the difference; the bot and the dashboard
 * (which loads it from dist) both go through it, so a run's start-up check, the
 * admin health page and the Rewrite tab can never disagree about whether the
 * humanizer is up. It reads no config of its own: callers pass the endpoint.
 */

export interface HumanizerEndpoint {
  /** Root of the server, without `/v1` or a trailing slash. */
  base: string;
  /** Present for a hosted API. Never sent to an endpoint it was not issued for. */
  apiKey?: string;
  model: string;
}

interface EnvLike {
  HUMANIZER_URL?: string;
  HUMANIZER_FALLBACK_URL?: string;
  HUMANIZER_API_KEY?: string;
  HUMANIZER_MODEL?: string;
}

const clean = (url: string | undefined) => (url ?? '').trim().replace(/\/(v1\/?)?$/, '');

/**
 * The endpoints to try, in order. The key belongs to HUMANIZER_URL alone: the
 * fallback is a machine of the operator's own, and a provider's key has no
 * business being sent to it.
 */
export function humanizerEndpoints(env: EnvLike): HumanizerEndpoint[] {
  const model = env.HUMANIZER_MODEL?.trim() || 'authormist-originality';
  const apiKey = env.HUMANIZER_API_KEY?.trim() || undefined;
  return [
    { base: clean(env.HUMANIZER_URL), apiKey, model },
    { base: clean(env.HUMANIZER_FALLBACK_URL), model },
  ].filter(endpoint => endpoint.base);
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
    if (!endpoint.apiKey) {
      const response = await fetch(`${endpoint.base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok ? { ready: true, detail: 'answering' } : { ready: false, detail: `health check returned HTTP ${response.status}` };
    }
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
 * returned as it is for the caller to report. Network errors are thrown, so a
 * caller with a fallback endpoint can tell "down" from "said no".
 */
export async function chatCompletion(
  endpoint: HumanizerEndpoint,
  body: Record<string, unknown>,
  deadline: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${endpoint.base}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(endpoint),
      body: JSON.stringify({ ...body, model: endpoint.model, stream: false }),
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });
    const wait = 1_500 * (attempt + 1);
    if (!RETRYABLE.has(response.status) || attempt >= MAX_RETRIES || Date.now() + wait >= deadline) return response;
    await response.arrayBuffer().catch(() => {}); // release the connection before waiting
    await new Promise(done => setTimeout(done, wait));
  }
}
