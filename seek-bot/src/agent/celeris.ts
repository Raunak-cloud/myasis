import { metric } from '../pipeline.js';
import { config } from '../config.js';

/**
 * Minimal client for Celeris' OpenAI-compatible chat API.
 *
 * Raw `fetch` rather than the `openai` SDK, matching humanizer.ts: the surface
 * we need is one endpoint, and this keeps the dependency list unchanged.
 */

export type CelerisModel = 'celeris-1' | 'celeris-1-magnus';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Already JSON-parsed. Malformed arguments surface as a parse error instead. */
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: RawToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface RawToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CelerisReply {
  text: string;
  toolCalls: ToolCall[];
  /** Kept verbatim so it can be appended to the transcript for the next turn. */
  message: ChatMessage;
}

/**
 * Celeris exposes one base URL *per model*: the model id is a path segment
 * ahead of the OpenAI-style `/v1` suffix, and the docs are explicit that the
 * path segment and the body's `model` field must agree. Pointing a magnus
 * request at the celeris-1 base URL fails, so this is derived, never
 * configured by hand.
 */
function endpointFor(model: CelerisModel): string {
  return `${config.celeris.baseUrl.replace(/\/+$/, '')}/${model}/v1/chat/completions`;
}

/** Published rates, USD per million tokens. */
const RATES = {
  promptUncached: 0.2,
  promptCached: 0.02,
  completion: 0.7,
} as const;

export interface UsageTotals {
  calls: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/**
 * Accumulates spend across one application and enforces a hard ceiling.
 *
 * An agent loop has no fixed step count, so an unrecognised page can otherwise
 * bill indefinitely. The budget is a deterministic rail: when it trips the run
 * stops, it does not ask the model whether to continue.
 */
export class CostMeter {
  readonly totals: UsageTotals = {
    calls: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  };

  constructor(private readonly budgetUsd: number) {}

  record(usage: unknown): void {
    const u = (usage ?? {}) as {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    const prompt = u.prompt_tokens ?? 0;
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    const uncached = Math.max(0, prompt - cached);

    this.totals.calls += 1;
    this.totals.promptTokens += prompt;
    this.totals.cachedPromptTokens += cached;
    this.totals.completionTokens += completion;
    this.totals.costUsd +=
      (uncached * RATES.promptUncached + cached * RATES.promptCached + completion * RATES.completion) / 1_000_000;
  }

  get exhausted(): boolean {
    return this.totals.costUsd >= this.budgetUsd;
  }

  summary(): string {
    const t = this.totals;
    const cacheRate = t.promptTokens ? Math.round((t.cachedPromptTokens / t.promptTokens) * 100) : 0;
    return `${t.calls} calls · ${t.promptTokens} prompt (${cacheRate}% cached) · ${t.completionTokens} completion · $${t.costUsd.toFixed(5)}`;
  }
}

export interface CelerisRequest {
  model: CelerisModel;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  /** Force a tool call rather than letting the model reply with prose. */
  requireTool?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Magnus only; ignored by celeris-1. */
  thinking?: boolean;
  /**
   * JSON Schema the reply must conform to, enforced server-side via
   * `response_format`. Use for a structured answer; use `tools` when the model
   * should choose an action.
   */
  responseSchema?: Record<string, unknown>;
  meter?: CostMeter;
}

export async function celerisChat(request: CelerisRequest): Promise<CelerisReply> {
  if (!config.celeris.apiKey) {
    throw new Error('CELERIS_API_KEY is not set — the browser agent cannot run without it.');
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    // Explicit max_tokens is both a cost rail and the documented recommendation.
    max_tokens: request.maxTokens ?? config.celeris.maxTokens,
    temperature: request.temperature ?? 0,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = request.requireTool ? 'required' : 'auto';
  }
  if (request.responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'reply', schema: request.responseSchema },
    };
  }
  if (request.thinking && request.model === 'celeris-1-magnus') {
    body.chat_template_kwargs = { enable_thinking: true };
  }

  const startedAt = performance.now();
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (Date.now() >= deadline) throw new Error('Model request deadline exceeded');
      const response = await fetch(endpointFor(request.model), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.celeris.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.min(config.celeris.timeoutMs, deadline - Date.now()))),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Celeris ${response.status}: ${detail.slice(0, 300)}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: RawToolCall[] } }>;
        usage?: unknown;
      };
      request.meter?.record(payload.usage);

      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error('Celeris returned no choices');

      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call) => {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          // Surfaced to the model as a tool error rather than crashing the run.
          args = { __parseError: call.function.arguments };
        }
        return { id: call.id, name: call.function.name, args };
      });

      metric('model', performance.now() - startedAt, { model: request.model, attempts: attempt + 1, usage: payload.usage });
      return {
        text: message.content ?? '',
        toolCalls,
        message: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls },
      };
    } catch (error) {
      lastError = error;
      const detail = (error as Error).message ?? String(error);
      const transient = /\b429\b|\b5\d\d\b|econnreset|etimedout|fetch failed|aborted|timeout/i.test(detail);
      if (!transient || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 700 * 2 ** attempt));
    }
  }
  throw lastError;
}
