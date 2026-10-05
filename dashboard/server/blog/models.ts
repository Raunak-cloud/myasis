import { readEnv } from '../runner.js';
import { askCelerisForJson } from '../search-terms.js';

interface ProviderConfig {
  provider: 'celeris' | 'gemini';
  apiKey: string;
  model: string;
}

export interface WriterConfig extends ProviderConfig {
  fallback?: ProviderConfig;
}

export function writerConfig(): WriterConfig | null {
  const env = readEnv();
  const setting = (key: string) => (process.env[key] ?? env[key] ?? '').trim();
  const celerisKey = setting('CELERIS_API_KEY');
  const geminiKey = setting('GEMINI_API_KEY');
  const gemini: ProviderConfig | undefined = geminiKey
    ? { provider: 'gemini', apiKey: geminiKey, model: setting('BLOG_GEMINI_MODEL') || 'gemini-3.8-flash' }
    : undefined;
  const provider = setting('BLOG_PROVIDER') || 'auto';
  if (provider === 'gemini') return gemini ?? null;
  if (provider !== 'auto' && provider !== 'celeris') return null;
  if (!celerisKey) return provider === 'auto' ? gemini ?? null : null;
  return { provider: 'celeris', apiKey: celerisKey, model: 'celeris-1-magnus', ...(provider === 'auto' && gemini ? { fallback: gemini } : {}) };
}

const TIMEOUT_MS = 5 * 60_000;

async function askGemini(config: ProviderConfig, system: string, prompt: string, schema: Record<string, unknown>, temperature: number): Promise<Record<string, unknown>> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: 32_768, responseMimeType: 'application/json', responseJsonSchema: schema },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
  const payload = await response.json() as {
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    promptFeedback?: { blockReason?: string };
  };
  const candidate = payload.candidates?.[0];
  if (candidate?.finishReason !== 'STOP') throw new Error(`Gemini did not finish the response (${candidate?.finishReason ?? payload.promptFeedback?.blockReason ?? 'no candidate'}).`);
  const answer = candidate.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? '').join('') ?? '';
  try {
    const value = JSON.parse(answer);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* report invalid output below */ }
  throw new Error('Gemini returned invalid JSON.');
}

/** Once Celeris exhausts its output budget, Gemini handles the rest of this post. */
export function createBlogModel(config: WriterConfig) {
  let active: ProviderConfig = config;
  return {
    model: () => active.model,
    async ask(system: string, prompt: string, schema: Record<string, unknown>, temperature: number): Promise<Record<string, unknown>> {
      if (active.provider === 'gemini') return askGemini(active, system, prompt, schema, temperature);
      const result = await askCelerisForJson(active.apiKey, system, prompt, schema, temperature, { maxOutputTokens: 16_384, timeoutMs: TIMEOUT_MS });
      if (result.ok && result.value) return result.value;
      if (result.tokenLimitReached && config.fallback) {
        active = config.fallback;
        console.log(`[blog] Celeris output limit reached; continuing with ${active.model}`);
        return askGemini(active, system, prompt, schema, temperature);
      }
      throw new Error(result.tokenLimitReached
        ? `${result.error} Add GEMINI_API_KEY in Config → Weekly blog to enable Gemini fallback.`
        : result.error ?? 'The model returned nothing.');
    },
  };
}
