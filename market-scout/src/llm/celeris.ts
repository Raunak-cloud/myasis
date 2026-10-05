import { config } from '../config.js';

/**
 * Client for Celeris' OpenAI-compatible chat API — the only model provider.
 *
 * Routing, by what each call needs:
 *  - `celeris-1`: short structured calls (page classification, chunk
 *    extraction, intent labels). Fast, accepts images.
 *  - `celeris-1-magnus`: planning, the browser agent's steps, synthesis and
 *    fact-checking. Reasons first; the reasoning is billed as completion.
 *
 * Raw `fetch` rather than an SDK: the surface is one endpoint.
 */

export type CelerisModel = 'celeris-1' | 'celeris-1-magnus';
export type ReasoningEffort = 'low' | 'medium' | 'xhigh';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Already parsed. Malformed arguments arrive as `{ __parseError }` for the loop to report back. */
  args: Record<string, unknown>;
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface RawToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: RawToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface CelerisReply {
  text: string;
  toolCalls: ToolCall[];
  /** Verbatim, for appending to the transcript. */
  message: ChatMessage;
}

/** The model id is a path segment that must agree with the body's `model`. */
const endpointFor = (model: CelerisModel) =>
  `${config.celeris.baseUrl.replace(/\/+$/, '')}/${model}/v1/chat/completions`;

/** Magnus answers 400 max_output_tokens_exceeded above this (measured 5 Oct 2026; celeris-1 accepts more). */
const MAGNUS_MAX_OUTPUT = 16_384;

/** Published rates, USD per million tokens. */
const RATES = { promptUncached: 0.2, promptCached: 0.02, completion: 0.7 } as const;

export class BudgetExceededError extends Error {}

/**
 * Spend across one research run, with a hard ceiling. Crawls and agent loops
 * have no natural end; the budget is the deterministic rail that stops them.
 */
export class CostMeter {
  calls = 0;
  promptTokens = 0;
  cachedTokens = 0;
  completionTokens = 0;
  costUsd = 0;

  constructor(public budgetUsd: number) {}

  /** Guarantees `usd` more headroom than already spent — for the final write-up of a run that spent its budget collecting. */
  reserve(usd: number): void {
    this.budgetUsd = Math.max(this.budgetUsd, this.costUsd + usd);
  }

  record(usage: unknown): void {
    const u = (usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    const prompt = u.prompt_tokens ?? 0;
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    this.calls += 1;
    this.promptTokens += prompt;
    this.cachedTokens += cached;
    this.completionTokens += completion;
    this.costUsd += ((prompt - cached) * RATES.promptUncached + cached * RATES.promptCached + completion * RATES.completion) / 1_000_000;
  }

  /** Fraction of the budget still unspent, 0..1. */
  get remaining(): number {
    return Math.max(0, 1 - this.costUsd / this.budgetUsd);
  }

  assertAvailable(): void {
    if (this.costUsd >= this.budgetUsd) throw new BudgetExceededError(`Model budget of $${this.budgetUsd} spent`);
  }

  summary(): string {
    const cacheRate = this.promptTokens ? Math.round((this.cachedTokens / this.promptTokens) * 100) : 0;
    return `${this.calls} model calls · ${this.promptTokens} prompt (${cacheRate}% cached) · ${this.completionTokens} completion · $${this.costUsd.toFixed(4)}`;
  }
}

export interface CelerisRequest {
  model: CelerisModel;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  requireTool?: boolean;
  temperature?: number;
  /** Magnus only. Magnus thinks by default, so the flag is always sent. */
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** JSON Schema enforced server-side via response_format. */
  responseSchema?: Record<string, unknown>;
  maxTokens?: number;
  meter?: CostMeter;
}

class RateLimitedError extends Error {
  constructor(readonly waitMs: number) {
    super('Celeris 429');
  }
}

/**
 * Model calls in flight across the whole run. Analyzers, section writers and
 * browser tasks all call at once; the workspace's output-tokens-per-minute
 * quota is shared, so concurrency is bounded here, once.
 */
class Gate {
  private waiting: Array<() => void> = [];
  constructor(private free: number) {}
  async acquire() {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}
const inFlight = new Gate(Math.max(1, Number(process.env.CELERIS_CONCURRENCY) || 4));

/** The reply exists but cannot be used; asking again the same way fails the same way. */
export class ReplyUnusableError extends Error {}

export async function celerisChat(request: CelerisRequest): Promise<CelerisReply> {
  if (!config.celeris.apiKey) throw new Error('CELERIS_API_KEY is not set.');
  request.meter?.assertAvailable();

  const magnus = request.model === 'celeris-1-magnus';
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? 0,
    // Generous on Magnus: its reasoning counts against max_tokens. Celeris rejects any request over the model's ceiling.
    max_tokens: magnus
      ? Math.min(MAGNUS_MAX_OUTPUT, Math.max(config.celeris.maxOutputTokens, (request.maxTokens ?? 0) * 4))
      : request.maxTokens ?? config.celeris.maxOutputTokens,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({ type: 'function', function: tool }));
    body.tool_choice = request.requireTool ? 'required' : 'auto';
  }
  if (request.responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'reply', strict: true, schema: strictSchema(request.responseSchema) },
    };
  }
  if (magnus) {
    body.chat_template_kwargs = {
      enable_thinking: Boolean(request.thinking),
      ...(request.thinking ? { reasoning_effort: request.reasoningEffort ?? 'low' } : {}),
    };
  }

  let lastError: unknown;
  let rateLimits = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await inFlight.acquire();
      let response: Response;
      try {
        response = await fetch(endpointFor(request.model), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.celeris.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.celeris.timeoutMs),
        });
      } finally {
        inFlight.release();
      }
      if (response.status === 429) {
        // A per-minute token quota: wait for the window, not a second.
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new RateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15_000 * 2 ** rateLimits);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        if (response.status === 400 && /response_format could not be satisfied|did not parse as JSON/i.test(detail)) {
          throw new ReplyUnusableError(`Celeris could not produce the requested format: ${detail.slice(0, 200)}`);
        }
        throw new Error(`Celeris ${response.status}: ${detail.slice(0, 300)}`);
      }
      const payload = (await response.json()) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: RawToolCall[] } }>;
        usage?: { completion_tokens?: number };
      };
      request.meter?.record(payload.usage);
      const choice = payload.choices?.[0];
      const message = choice?.message;
      if (!message) throw new Error('Celeris returned no choices');
      if (choice.finish_reason === 'length') {
        throw new ReplyUnusableError(`Celeris reply cut off after ${payload.usage?.completion_tokens ?? '?'} completion tokens`);
      }
      const toolCalls = (message.tool_calls ?? []).map((call): ToolCall => {
        try {
          return { id: call.id, name: call.function.name, args: call.function.arguments ? JSON.parse(call.function.arguments) : {} };
        } catch {
          return { id: call.id, name: call.function.name, args: { __parseError: call.function.arguments } };
        }
      });
      return {
        text: message.content ?? '',
        toolCalls,
        message: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls },
      };
    } catch (error) {
      lastError = error;
      if (error instanceof RateLimitedError) {
        // Rate limits do not use up the ordinary retries; five waits (up to a minute each) do.
        if (++rateLimits > 5) throw new Error('Celeris kept rate-limiting this workspace (output tokens per minute)');
        attempt -= 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, error.waitMs) + Math.random() * 2_000));
        continue;
      }
      if (error instanceof ReplyUnusableError) {
        if (attempt > 0) throw error;
        body.messages = [...request.messages, { role: 'user', content: 'Your previous reply was unusable. Return one concise, complete reply in the required format.' }];
        continue;
      }
      const transient = /\b429\b|\b5\d\d\b|econnreset|etimedout|fetch failed|aborted|timeout/i.test(String((error as Error).message));
      if (!transient || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
  }
  throw lastError;
}

/**
 * One structured answer. `schema` is plain JSON Schema; every object field is
 * made required with no extras — with optional fields Celeris' constrained
 * decoding has written keys as values. Absent facts come back as "" or [].
 */
export async function askJson<T>(options: {
  model: CelerisModel;
  system: string;
  prompt: string | ContentPart[];
  schema: Record<string, unknown>;
  meter?: CostMeter;
  effort?: ReasoningEffort;
  /** Magnus only. On by default; off for writing up analysis that is already done, where reasoning ran replies past their ceiling. */
  thinking?: boolean;
  maxTokens?: number;
  temperature?: number;
}): Promise<T> {
  const reply = await celerisChat({
    model: options.model,
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: options.prompt },
    ],
    responseSchema: options.schema,
    thinking: options.model === 'celeris-1-magnus' && options.thinking !== false,
    reasoningEffort: options.effort,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    meter: options.meter,
  });
  const parsed = parseJsonObject(reply.text);
  if (parsed === undefined) throw new ReplyUnusableError(`Celeris returned invalid JSON: ${reply.text.slice(0, 160)}`);
  return parsed as T;
}

export function strictSchema(node: unknown): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
      out.required = Object.keys(out.properties as Record<string, unknown>);
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(node) as Record<string, unknown>;
}

/** Tolerates a reply wrapped in a code fence or prose around the object. */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** Rough token count, for transcript trimming and chunking. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);
