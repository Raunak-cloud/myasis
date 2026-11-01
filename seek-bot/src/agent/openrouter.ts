import { setTimeout as pause } from 'node:timers/promises';
import { applicationModelEnvironment, applicationAgentIdentity } from '../application-model.js';
import { OPENROUTER_APPLICATION_MODELS } from '../application-model-catalog.js';
import { beginCostRequest, recordCost } from '../cost-ledger.js';
import { providerOutOfCredit } from '../run-health.js';
import { metric } from '../pipeline.js';
import { recordDiagnostic } from './attempt-diagnostics.js';
import { estimateTranscriptTokens } from './loop/transcript.js';
import { ApplicationBudgetExhaustedError, ReplyUnusableError, type CelerisReply,
  type CelerisRequest, type ChatMessage, type ToolCall } from './celeris.js';
import { boundedReasoningEffort, GenerationRecovery, GenerationWindowError, generationFailure } from './generation-recovery.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// Published non-discounted rates, USD/token, checked 2026-11-02. Actual usage.cost
// takes precedence, including time-dependent prices and cache discounts.
function ratesFor(model: string, prompt: number) {
  // Qwen's published context tiers; actual provider charges always win.
  if (model === OPENROUTER_APPLICATION_MODELS.qwen.model) return prompt >= 256_000
    ? { prompt: 0.0000002, cached: 0.00000004, completion: 0.0000008 }
    : prompt >= 32_000 ? { prompt: 0.0000001, cached: 0.00000002, completion: 0.0000004 }
    : { prompt: 0.00000003, cached: 0.000000006, completion: 0.00000013 };
  return { prompt: 0.00000015, cached: 0.000000015, completion: 0.0000006 };
}
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
  const rates = ratesFor(String(body.model), prompt);
  const amountUsd = exact ? usage!.cost! : (prompt - cached) * rates.prompt + cached * rates.cached + completion * rates.completion;
  request.meter?.recordProvider({ prompt, cached, completion, amountUsd });
  recordCost({ provider: 'OpenRouter', model: String(body.model), amountUsd: exact || measured ? amountUsd : null,
    basis: exact ? 'provider' : measured ? 'estimated' : 'unknown',
    detail: exact ? `Provider-reported charge; ${prompt} input (${cached} cached), ${completion} output tokens including reasoning.`
      : measured ? `Published undiscounted rates; ${prompt} input (${cached} cached), ${completion} output tokens. Provider charge unavailable.`
        : 'Usage unavailable. Budget reserves estimated input and the full requested output; final charge is unknown.' });
}

/** OpenRouter transport only. Browser actions, recovery, screenshots, evidence
 * and budgets are the same applying-agent loop used by Celeris. No provider
 * fallback changes the selected model, and no browser action is retried here. */
export async function openrouterChat(request: CelerisRequest): Promise<CelerisReply> {
  const identity = applicationAgentIdentity();
  if (identity.provider !== 'OpenRouter') throw new Error('Select an OpenRouter application model first.');
  const model = OPENROUTER_APPLICATION_MODELS[identity.selection];
  const key = applicationModelEnvironment().OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error('OPENROUTER_API_KEY is required for the selected application agent.');
  if (request.forceTool && !request.tools?.some(tool => tool.name === request.forceTool)) throw new Error('Forced tool is not in the offered tools.');
  const body: Record<string, unknown> = {
    model: model.model, messages: request.messages,
    temperature: request.temperature ?? 0, max_tokens: request.maxTokens ?? 8192,
    reasoning: { effort: boundedReasoningEffort(request.reasoningEffort, 'medium') },
    provider: { require_parameters: true },
  };
  if (request.tools?.length) {
    // Qwen's thinking endpoint supports auto tool selection, not `required`.
    // Offer only the requested checkpoint tool when forcing one. The shared
    // application loop still validates that checkpoint before any action.
    const tools = model.toolChoice === 'auto' && request.forceTool
      ? request.tools.filter(tool => tool.name === request.forceTool) : request.tools;
    body.tools = tools.map(tool => ({ type: 'function', function: tool }));
    body.tool_choice = model.toolChoice === 'auto' ? 'auto'
      : request.forceTool ? { type: 'function', function: { name: request.forceTool } }
        : request.requireTool ? 'required' : 'auto';
    if (model.toolChoice === 'auto' && (request.forceTool || request.requireTool)) body.messages = [
      { role: 'system', content: request.forceTool
        ? `For this turn return exactly one ${request.forceTool} tool call with its required arguments. Do not return prose or other actions.`
        : 'Choose and call an offered tool for this turn. Complete the task through tool calls; use the offered finish tool for your final outcome.' },
      ...request.messages,
    ];
  }
  if (request.responseSchema) {
    if (model.structuredOutput === 'json_schema') body.response_format = {
      type: 'json_schema', json_schema: { name: 'reply', schema: request.responseSchema },
    };
    else {
      // Qwen supports JSON mode, not provider-enforced JSON Schema. Existing
      // callers still validate the returned object against their typed schema.
      body.response_format = { type: 'json_object' };
      body.messages = [{ role: 'system', content: 'Return only a JSON object matching this schema: ' + JSON.stringify(request.responseSchema) }, ...body.messages as ChatMessage[]];
    }
  }
  const recovery = new GenerationRecovery({ ...request, messages: body.messages as ChatMessage[] }, 60_000, Number(body.max_tokens));
  const started = performance.now();
  let lastError: unknown, unusableReply: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (request.meter?.exhausted) throw new ApplicationBudgetExhaustedError();
    let status: number | undefined, retryAfter: string | null = null, sent = false, recorded = false;
    const endCost = beginCostRequest('OpenRouter', model.model);
    try {
      recovery.assertWindow(attempt);
      recordDiagnostic({ severity: 'info', category: 'generation_attempt', stage: 'model_request', tool: model.model,
        retry: attempt + 1, message: JSON.stringify({ maxTokens: body.max_tokens, timeoutMs: recovery.timeoutMs,
          remainingMs: Math.max(0, recovery.deadline - Date.now()), reasoning: body.reasoning }) });
      sent = true;
      const response = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://owtomate.com', 'X-Title': 'Owtomate admin application agent' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.min(recovery.timeoutMs, recovery.deadline - Date.now()))),
      });
      status = response.status;
      retryAfter = response.headers.get('retry-after');
      const payload = await response.json().catch(() => null) as Payload | null;
      if (!response.ok || payload?.error) {
        if (payload?.usage) recordUsage(request, body, payload.usage);
        else recordCost({ provider: 'OpenRouter', model: String(body.model), amountUsd: null, basis: 'unknown',
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
      metric('model', performance.now() - started, { model: String(body.model), attempts: attempt + 1,
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
        stage: 'model_request', tool: model.model, retry: attempt + 1,
        message: error instanceof Error ? error.message : String(error), error });
      if (error instanceof GenerationWindowError) throw generationFailure('OpenRouter', lastError ?? error, unusableReply);
      lastError = error;
      if (error instanceof ReplyUnusableError) {
        if (attempt === 2 || !recovery.adapt(body, 'unusable', true))
          throw generationFailure('OpenRouter', error, unusableReply);
        unusableReply = error;
        continue;
      }
      const transient = status === 429 || (status !== undefined && status >= 500 && status < 600)
        || (status === undefined && /fetch failed|econnreset|timeout|timed out|aborted/i.test(String(error)));
      if (!transient || attempt === 2) throw unusableReply ? generationFailure('OpenRouter', error, unusableReply) : error;
      if (status === undefined) recovery.adapt(body, 'timeout');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const floor = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter ?? '') - Date.now()) || 0;
      const delay = floor + Math.floor(Math.random() * Math.min(10_000, 700 * 2 ** attempt));
      if (Date.now() + delay >= recovery.backoffDeadline) throw generationFailure('OpenRouter retry deadline', error, unusableReply);
      await pause(delay);
      recovery.refreshWindow();
    } finally { endCost(); }
  }
  throw new Error('OpenRouter request attempts exhausted.');
}
