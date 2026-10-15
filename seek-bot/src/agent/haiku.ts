import type { CelerisRequest, CelerisReply, ChatMessage } from './celeris.js';
import { beginCostRequest, recordCost } from '../cost-ledger.js';
import { metric } from '../pipeline.js';
import { providerOutOfCredit } from '../run-health.js';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

/** Native Messages protocol, not an OpenAI Chat-shaped Haiku request. */
export interface HaikuRoute {
  provider: 'OpenRouter' | 'Anthropic';
  apiKey: string;
  model: string;
  endpoint: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
}
type Block = Record<string, unknown>;
type NativeMessage = { role: 'user' | 'assistant'; content: Block[] };
type NativeUsage = {
  input_tokens?: unknown; output_tokens?: unknown;
  cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown;
  cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown };
  cost?: unknown;
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const object = (v: unknown): v is Block => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const expectedModels = new Set(['claude-haiku-5-5', 'anthropic/claude-haiku-5.5']);
const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();
function validator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (!validate) { validate = ajv.compile(schema); validators.set(key, validate); }
  return validate;
}

function contentBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new Error('Haiku message content must be text or content blocks');
  return content.map(part => {
    if (!object(part)) throw new Error('Invalid Haiku content block');
    if (part.type === 'text' && typeof part.text === 'string') return structuredClone(part);
    if (part.type !== 'image_url' || !object(part.image_url) || typeof part.image_url.url !== 'string') {
      throw new Error('Unsupported Haiku input content block');
    }
    const url = part.image_url.url;
    const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
    if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
    if (/^https:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
    throw new Error('Unsupported Haiku image source');
  });
}

/** No edits, summaries or signed-block reconstruction in the provider adapter. */
export function haikuMessages(messages: ChatMessage[]): { system: Block[]; messages: NativeMessage[] } {
  const system: Block[] = [], result: NativeMessage[] = [];
  const allIds = new Set<string>();
  let pending: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'system') {
      if (result.length) throw new Error('Haiku system prefix must remain unchanged; start a fresh conversation');
      const blocks = contentBlocks(message.content);
      if (blocks.some(b => b.type !== 'text')) throw new Error('Haiku system content must be text');
      system.push(...blocks); continue;
    }
    if (message.role === 'tool') {
      if (!pending.length) throw new Error('Haiku tool result has no immediately preceding tool use');
      const blocks: Block[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const tool = messages[i] as Extract<ChatMessage, { role: 'tool' }>;
        if (!pending.includes(tool.tool_call_id)) throw new Error('Haiku tool result ID is unknown or duplicated');
        pending = pending.filter(id => id !== tool.tool_call_id);
        blocks.push({ type: 'tool_result', tool_use_id: tool.tool_call_id, content: tool.content }); i++;
      }
      i--;
      if (pending.length) throw new Error('Haiku tool results must answer every tool use before the next turn');
      result.push({ role: 'user', content: blocks }); continue;
    }
    if (pending.length) throw new Error('Haiku tool results must immediately follow the assistant tool use');
    if (message.role === 'assistant') {
      let blocks: Block[];
      if (message.anthropic_content) {
        if (!message.anthropic_content.every(object)) throw new Error('Invalid stored Haiku content blocks');
        blocks = structuredClone(message.anthropic_content) as Block[];
      } else {
        if (message.reasoning_details || message.reasoning_content) throw new Error('Cannot replay another protocol’s reasoning as Haiku thinking');
        blocks = contentBlocks(message.content ?? '');
        for (const call of message.tool_calls ?? []) {
          let input: unknown;
          try { input = JSON.parse(call.function.arguments); } catch { throw new Error('Stored Haiku tool arguments are incomplete JSON'); }
          if (!object(input)) throw new Error('Stored Haiku tool arguments must be an object');
          blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
        }
      }
      for (const block of blocks.filter(b => b.type === 'tool_use')) {
        if (typeof block.id !== 'string' || !block.id || allIds.has(block.id) || typeof block.name !== 'string' || !object(block.input)) {
          throw new Error('Stored Haiku tool use is invalid or its ID was reused');
        }
        allIds.add(block.id); pending.push(block.id);
      }
      if (!blocks.length) throw new Error('Empty stored Haiku assistant message');
      result.push({ role: 'assistant', content: blocks }); continue;
    }
    result.push({ role: 'user', content: contentBlocks(message.content) });
  }
  if (pending.length) throw new Error('Haiku tool results are missing');
  if (!result.length || result.at(-1)?.role !== 'user') throw new Error('Haiku messages must end with a user/tool-result turn, not assistant prefill');
  return { system, messages: result };
}

/** Match the documented SDK transformation while Ajv retains the original contract. */
export function haikuSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(haikuSchema);
  if (!object(value)) return value;
  const result: Block = {}, descriptions: Block = {};
  const remove = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'pattern']);
  const formats = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);
  for (const [key, item] of Object.entries(value)) {
    if (remove.has(key) || key === 'minItems' && item !== 0 && item !== 1 || key === 'format' && !formats.has(String(item))) {
      descriptions[key] = item; continue;
    }
    if (['properties', '$defs', 'definitions'].includes(key) && object(item)) {
      result[key] = Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, haikuSchema(schema)]));
    } else if (['items', 'additionalProperties', 'not'].includes(key) && object(item)) result[key] = haikuSchema(item);
    else if (['anyOf', 'allOf', 'oneOf', 'prefixItems'].includes(key) && Array.isArray(item)) result[key] = item.map(haikuSchema);
    else result[key] = structuredClone(item);
  }
  if (Object.keys(descriptions).length) result.description = [value.description, `Additional requirements: ${JSON.stringify(descriptions)}`].filter(Boolean).join('\n');
  if (result.type === 'object' || result.properties) result.additionalProperties = false;
  return result;
}

export function haikuBody(request: CelerisRequest, route: HaikuRoute): Record<string, unknown> {
  if (!expectedModels.has(route.model)) throw new Error('Haiku route must select the pinned Claude Haiku 5.5 model');
  const transcript = haikuMessages(request.messages);
  const maxTokens = request.maxTokens ?? 8192;
  if (!finite(maxTokens) || maxTokens === 0) throw new Error('Invalid Haiku output token limit');
  if (request.responseSchema) validator(request.responseSchema);
  for (const tool of request.tools ?? []) validator(tool.parameters);
  const body: Record<string, unknown> = {
    model: route.model, ...transcript, max_tokens: Math.min(128000, Math.max(4096, maxTokens)),
    thinking: { type: 'adaptive' }, output_config: { effort: route.effort ?? 'medium',
      ...(request.responseSchema ? { format: { type: 'json_schema', schema: haikuSchema(request.responseSchema) } } : {}) },
    // Native automatic caching moves the breakpoint without rewriting stored thinking blocks.
    cache_control: { type: 'ephemeral' }, stream: false,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    // Forced calls skip adaptive thinking. The controller handles a plain-text turn.
    body.tool_choice = { type: 'auto' };
  }
  if (route.provider === 'OpenRouter') body.provider = {
    only: ['anthropic'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny',
  };
  return body;
}

/** Native input_tokens excludes cache reads/writes; cached tokens are not a subset here. */
export function haikuUsage(usage: NativeUsage | undefined) {
  if (!usage || !finite(usage.input_tokens) || !finite(usage.output_tokens)) return null;
  const read = finite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
  const created = finite(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0;
  const oneHour = finite(usage.cache_creation?.ephemeral_1h_input_tokens) ? usage.cache_creation.ephemeral_1h_input_tokens : 0;
  if (oneHour > created) return null;
  const total = usage.input_tokens + read + created, multiplier = total > 100000 ? 5 : 1;
  const estimatedUsd = multiplier * (usage.input_tokens * .10 + read * .01 + (created - oneHour) * .125 + oneHour * .20 + usage.output_tokens * .50) / 1_000_000;
  return { prompt_tokens: total, prompt_tokens_details: { cached_tokens: read }, completion_tokens: usage.output_tokens, estimatedUsd };
}

class HaikuHttpError extends Error { constructor(readonly status: number) { super(`Haiku provider HTTP ${status}`); } }

async function reportedCost(payload: Block, route: HaikuRoute, deadline: number): Promise<number | null> {
  const usage = object(payload.usage) ? payload.usage : {};
  if (finite(usage.cost)) return usage.cost;
  if (route.provider !== 'OpenRouter') return null;
  const metadata = object(payload.openrouter_metadata) ? payload.openrouter_metadata : {};
  const id = [payload.id, metadata.generation_id].find(v => typeof v === 'string' && /^gen-[A-Za-z0-9_-]+$/.test(v));
  const left = deadline - Date.now();
  if (!id || left <= 0) return null;
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(String(id))}`, {
      headers: { authorization: `Bearer ${route.apiKey}` }, signal: AbortSignal.timeout(Math.max(1, Math.min(3000, left))),
    });
    if (!response.ok) return null;
    const data = ((await response.json()) as { data?: Block }).data;
    if (!data || data.id !== id || !expectedModels.has(String(data.model)) || String(data.provider_name).toLowerCase() !== 'anthropic') return null;
    return finite(data.total_cost) ? data.total_cost : null;
  } catch { return null; }
}

export async function haikuChat(request: CelerisRequest, route: HaikuRoute): Promise<CelerisReply> {
  if (!route.apiKey) throw new Error('The selected Haiku provider key is not configured');
  const body = haikuBody(request, route), timeout = route.timeoutMs ?? 120000;
  if (!finite(timeout) || timeout < 1) throw new Error('Invalid Haiku request deadline');
  const deadline = Date.now() + timeout, started = performance.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const endCost = beginCostRequest(route.provider, route.model);
    let costRecorded = false, signal: AbortSignal | undefined;
    try {
      if (Date.now() >= deadline) throw new Error('Haiku request deadline exceeded');
      signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const response = await fetch(route.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
          ...(route.provider === 'Anthropic' ? { 'x-api-key': route.apiKey } : {
            authorization: `Bearer ${route.apiKey}`, 'X-OpenRouter-Metadata': 'enabled',
            'HTTP-Referer': 'https://owtomate.com', 'X-Title': 'Owtomate Haiku native agent',
          }) }, body: JSON.stringify(body), signal,
      });
      const payload: Block = await response.json().catch(error => { if (response.ok) throw error; return {}; });
      const usage = haikuUsage(payload.usage as NativeUsage | undefined);
      const actual = await reportedCost(payload, route, deadline);
      const amount = route.provider === 'Anthropic' ? actual ?? usage?.estimatedUsd ?? null : actual;
      recordCost({ provider: route.provider, model: route.model, amountUsd: amount,
        basis: actual !== null ? 'provider' : route.provider === 'Anthropic' && usage ? 'estimated' : 'unknown',
        detail: actual !== null ? 'Native Messages provider-reported charge, including cache and thinking.'
          : route.provider === 'Anthropic' && usage ? 'Native Messages usage at published Haiku 5.5 USD rates; long-prompt and cache-write rates included.'
            : 'Native Messages final charge unavailable. A usage-based estimate is used only for the request budget when available.' });
      costRecorded = true;
      // Paid unsuccessful/truncated replies count toward the same application budget.
      if (usage) request.meter?.record(usage, actual ?? usage.estimatedUsd);
      if (!response.ok) {
        if (response.status === 402) providerOutOfCredit(route.provider);
        throw new HaikuHttpError(response.status);
      }
      if (!expectedModels.has(String(payload.model))) throw new Error('Haiku model identity could not be verified; no action returned');
      if (payload.provider && String(payload.provider).toLowerCase() !== 'anthropic') throw new Error('Haiku upstream provider identity did not match; no action returned');
      if (!usage) throw new Error('Haiku token usage unavailable; request budget cannot be verified');
      if (!['tool_use', 'end_turn', 'stop_sequence'].includes(String(payload.stop_reason))) {
        throw new Error(`Haiku reply cannot be executed (${String(payload.stop_reason)}); no action returned`);
      }
      if (!Array.isArray(payload.content) || !payload.content.every(object)) throw new Error('Haiku returned invalid native content');
      const blocks = payload.content as Block[], names = new Set(request.tools?.map(t => t.name)), ids = new Set<string>();
      const toolCalls = blocks.filter(b => b.type === 'tool_use').map(block => {
        if (typeof block.id !== 'string' || !block.id || ids.has(block.id) || typeof block.name !== 'string' || !names.has(block.name) || !object(block.input)) {
          throw new Error('Haiku tool use is invalid or names an unavailable tool; no action returned');
        }
        const definition = request.tools!.find(t => t.name === block.name)!;
        if (!validator(definition.parameters)(block.input)) throw new Error('Haiku tool input did not satisfy its original schema; no action returned');
        ids.add(block.id); return { id: block.id, name: block.name, args: block.input };
      });
      if ((payload.stop_reason === 'tool_use') !== Boolean(toolCalls.length)) throw new Error('Haiku stop reason and native tool blocks disagree; no action returned');
      const text = blocks.filter(b => b.type === 'text').map(b => typeof b.text === 'string' ? b.text : '').join('\n');
      if (!text && !toolCalls.length) throw new Error('Haiku returned no visible answer or tool use');
      if (request.responseSchema && !toolCalls.length) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw new Error('Haiku structured answer was not complete JSON'); }
        if (!validator(request.responseSchema)(parsed)) throw new Error('Haiku structured answer did not satisfy its original schema');
      }
      metric('model', performance.now() - started, { model: route.model, provider: route.provider, attempts: attempt + 1, usage: payload.usage });
      return { text, toolCalls, message: { role: 'assistant', content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls.map(t => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}),
        anthropic_content: structuredClone(blocks) } };
    } catch (error) {
      if (!costRecorded) recordCost({ provider: route.provider, model: route.model, amountUsd: null, basis: 'unknown', detail: 'Native Messages request did not yield final usage; it may have incurred charges.' });
      lastError = error;
      const e = error as Error & { code?: string; cause?: { code?: string } };
      const timeoutError = Boolean(signal?.aborted && signal.reason?.name === 'TimeoutError') || ['TimeoutError', 'ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].some(code => [e.name, e.code, e.cause?.code].includes(code));
      const transient = error instanceof HaikuHttpError ? error.status === 429 || error.status >= 500 : timeoutError || /fetch failed/i.test(e.message ?? '');
      if (!transient || attempt || deadline - Date.now() <= 1001) throw error;
    } finally { endCost(); }
    // Retry transport only; no browser action has been returned or run.
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw lastError;
}
