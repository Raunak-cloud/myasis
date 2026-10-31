import { setTimeout as pause } from 'node:timers/promises';
import { applicationModelEnvironment, MINIMAX_APPLICATION_MODEL } from '../application-model.js';
import { beginCostRequest, recordCost } from '../cost-ledger.js';
import { providerOutOfCredit } from '../run-health.js';
import { metric } from '../pipeline.js';
import { recordDiagnostic } from './attempt-diagnostics.js';
import { estimateTranscriptTokens } from './loop/transcript.js';
import { ApplicationBudgetExhaustedError, ReplyUnusableError, type CelerisReply,
  type CelerisRequest, type ChatMessage, type ToolCall } from './celeris.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// Published non-discounted rates, USD/token, checked 2026-10-31. Actual usage.cost
// takes precedence, including time-dependent prices and cache discounts.
const RATES = { prompt: 0.00000015, cached: 0.000000015, completion: 0.0000006 };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;
interface Payload {
  choices?: { finish_reason?: string; message?: AssistantMessage }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number | null;
    prompt_tokens_details?: { cached_tokens?: number } };
  error?: { code?: number; message?: string };
}

function recordUsage(request: CelerisRequest, body: Record<string, unknown>, usage?: Payload['usage']): void {
  const measured = finite(usage?.prompt_tokens) && finite(usage?.completion_tokens);
  const prompt = measured ? usage!.prompt_tokens! : estimateTranscriptTokens(body.messages as ChatMessage[]);
  const completion = measured ? usage!.completion_tokens! : Number(body.max_tokens);
  const cached = measured && finite(usage?.prompt_tokens_details?.cached_tokens)
    ? Math.min(prompt, usage!.prompt_tokens_details!.cached_tokens!) : 0;
  const exact = finite(usage?.cost);
  const amountUsd = exact ? usage!.cost! : (prompt - cached) * RATES.prompt + cached * RATES.cached + completion * RATES.completion;
  request.meter?.recordProvider({ prompt, cached, completion, amountUsd });
  recordCost({ provider: 'OpenRouter', model: MINIMAX_APPLICATION_MODEL, amountUsd: exact || measured ? amountUsd : null,
    basis: exact ? 'provider' : measured ? 'estimated' : 'unknown',
    detail: exact ? `Provider-reported charge; ${prompt} input (${cached} cached), ${completion} output tokens including reasoning.`
      : measured ? `Published undiscounted rates; ${prompt} input (${cached} cached), ${completion} output tokens. Provider charge unavailable.`
        : 'Usage unavailable. Budget reserves estimated input and the full requested output; final charge is unknown.' });
}

/** OpenRouter transport only. Browser actions, recovery, screenshots, evidence
 * and budgets are the same applying-agent loop used by Celeris. No provider
 * fallback changes the selected model, and no browser action is retried here. */
export async function openrouterChat(request: CelerisRequest): Promise<CelerisReply> {
  const key = applicationModelEnvironment().OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error('OPENROUTER_API_KEY is required for the MiniMax application agent.');
  if (request.forceTool && !request.tools?.some(tool => tool.name === request.forceTool)) throw new Error('Forced tool is not in the offered tools.');
  const body: Record<string, unknown> = {
    model: MINIMAX_APPLICATION_MODEL, messages: request.messages,
    temperature: request.temperature ?? 0, max_tokens: request.maxTokens ?? 8192,
    reasoning: { effort: request.reasoningEffort ?? 'medium' },
    provider: { require_parameters: true },
  };
  if (request.tools?.length) {
    body.tools = request.tools.map(tool => ({ type: 'function', function: tool }));
    body.tool_choice = request.forceTool ? { type: 'function', function: { name: request.forceTool } }
      : request.requireTool ? 'required' : 'auto';
  }
  if (request.responseSchema) body.response_format = {
    type: 'json_schema', json_schema: { name: 'reply', schema: request.responseSchema },
  };
  let deadline = Math.min(Date.now() + 60_000, request.deadline ?? Infinity);
  const started = performance.now();
  let resampled = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (request.meter?.exhausted) throw new ApplicationBudgetExhaustedError();
    if (Date.now() >= deadline) throw new Error('OpenRouter request deadline reached.');
    let status: number | undefined, retryAfter: string | null = null, sent = false, recorded = false;
    const endCost = beginCostRequest('OpenRouter', MINIMAX_APPLICATION_MODEL);
    try {
      sent = true;
      const response = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://owtomate.com', 'X-Title': 'Owtomate admin application agent' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      status = response.status;
      retryAfter = response.headers.get('retry-after');
      const payload = await response.json().catch(() => null) as Payload | null;
      if (!response.ok || payload?.error) {
        if (payload?.usage) recordUsage(request, body, payload.usage);
        else recordCost({ provider: 'OpenRouter', model: MINIMAX_APPLICATION_MODEL, amountUsd: null, basis: 'unknown',
          detail: `HTTP ${status}: rejected or failed request; provider charge not reported.` });
        recorded = true;
        endCost();
        // In-band errors can arrive with HTTP 200; retain their real status
        // for retry classification rather than treating them as an empty reply.
        status = payload?.error?.code ?? status;
        if (status === 402) providerOutOfCredit('OpenRouter');
        const detail = String(payload?.error?.message ?? response.statusText).replaceAll(key, '[credential withheld]');
        throw new Error(`OpenRouter ${status}: ${detail.slice(0, 300)}`);
      }
      recordUsage(request, body, payload?.usage);
      recorded = true;
      endCost();
      const choice = payload?.choices?.[0], message = choice?.message;
      if (!message) throw new ReplyUnusableError('OpenRouter returned no completed assistant message.');
      if (choice.finish_reason === 'length') throw new ReplyUnusableError('OpenRouter reply truncated by the output token limit.');
      if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'error') throw new Error(`OpenRouter reply ended with ${choice.finish_reason}.`);
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map(call => {
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.function.arguments || '{}'); }
        catch { args = { __parseError: call.function.arguments }; }
        return { id: call.id, name: call.function.name, args };
      });
      metric('model', performance.now() - started, { model: MINIMAX_APPLICATION_MODEL, attempts: attempt + 1,
        usage: payload?.usage });
      return { text: message.content ?? '', toolCalls, message: {
        role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls,
        // Signed/opaque reasoning blocks must survive tool turns unchanged.
        ...(message.reasoning_details ? { reasoning_details: message.reasoning_details }
          : message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
      } };
    } catch (error) {
      if (sent && !recorded) recordUsage(request, body);
      endCost();
      if (!(error instanceof ApplicationBudgetExhaustedError)) recordDiagnostic({ severity: 'warning', category: 'provider_error',
        stage: 'model_request', tool: MINIMAX_APPLICATION_MODEL, retry: attempt + 1,
        message: error instanceof Error ? error.message : String(error), error });
      if (error instanceof ReplyUnusableError && !resampled && attempt < 2) {
        resampled = true;
        body.messages = [...request.messages, { role: 'user', content: 'Your previous response was incomplete. Return one concise, complete response in the required format.' }];
        body.max_tokens = Math.min(16_384, Number(body.max_tokens) * 2);
        deadline = Math.min(Date.now() + 60_000, request.deadline ?? Infinity);
        continue;
      }
      const transient = status === 429 || (status !== undefined && status >= 500 && status < 600)
        || (status === undefined && /fetch failed|econnreset|timeout|timed out|aborted/i.test(String(error)));
      if (!transient || attempt === 2) throw error;
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const floor = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter ?? '') - Date.now()) || 0;
      const delay = floor + Math.floor(Math.random() * Math.min(10_000, 700 * 2 ** attempt));
      if (Date.now() + delay >= deadline) throw new Error(`OpenRouter retry deadline reached after: ${String(error)}`, { cause: error });
      await pause(delay);
    } finally { endCost(); }
  }
  throw new Error('OpenRouter request attempts exhausted.');
}
