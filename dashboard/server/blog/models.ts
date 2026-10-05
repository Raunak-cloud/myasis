import { readEnv } from '../runner.js';
import { setTimeout as delay } from 'node:timers/promises';
export interface WriterConfig {
  provider: 'gemini';
  apiKey: string;
  model: string;
}

export function writerConfig(): WriterConfig | null {
  const env = readEnv();
  const setting = (key: string) => (process.env[key] ?? env[key] ?? '').trim();
  const geminiKey = setting('GEMINI_API_KEY');
  return geminiKey
    ? { provider: 'gemini', apiKey: geminiKey, model: setting('BLOG_GEMINI_MODEL') || 'gemini-3.5-flash' }
    : null;
}

const TIMEOUT_MS = 5 * 60_000;

async function askGemini(config: WriterConfig, system: string, prompt: string, schema: Record<string, unknown>, temperature: number): Promise<Record<string, unknown>> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const fields = schema.properties as Record<string, unknown> | undefined;
  // Flash-Lite's high reasoning shares this allowance with the JSON answer.
  const maxOutputTokens = config.model.includes('flash-lite') ? 65_536 : fields?.approved || fields?.edits ? 16_384 : 32_768;
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature, maxOutputTokens, responseMimeType: 'application/json', responseJsonSchema: schema,
        ...(config.model.includes('flash-lite') ? { thinkingConfig: { thinkingLevel: 'HIGH' } } : {}),
      },
    }),
      signal,
    });
    if (attempt >= 2 || ![429, 500, 502, 503, 504].includes(response.status)) break;
    await response.text();
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Math.max(500 * 2 ** attempt, Number.isFinite(retryAfter) ? Math.min(15_000, retryAfter * 1_000) : 0);
    console.log(`[blog] Gemini HTTP ${response.status}; retrying request (${attempt + 1}/2)`);
    await delay(waitMs, undefined, { signal });
  }
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

/** Gemini handles every draft, fact check and revision, including extra posts. */
export function createBlogModel(config: WriterConfig) {
  return {
    model: () => config.model,
    ask: (system: string, prompt: string, schema: Record<string, unknown>, temperature: number) => askGemini(config, system, prompt, schema, temperature),
  };
}
