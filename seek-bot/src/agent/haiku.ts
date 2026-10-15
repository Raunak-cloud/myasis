import type { CelerisRequest, CelerisReply, ChatMessage } from './celeris.js';
import { beginCostRequest, recordCost } from '../cost-ledger.js';
import { metric } from '../pipeline.js';
import { providerOutOfCredit } from '../run-health.js';
import { createHash } from 'node:crypto';
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

/**
 * Haiku mirrors the reasoning tier each call already asks Celeris for.
 * Celeris-1 classifications (fit, rules, ranking, yes/no checks) run without
 * reasoning, so Haiku answers them at low effort with thinking off, which
 * Anthropic recommends for short, high-volume requests. Calls that ask for
 * deeper reasoning (exception review, deeper letters) get high. A tool
 * conversation keeps one level throughout: changing top-level effort
 * mid-conversation invalidates its prompt cache.
 */
export function haikuReasoning(request: CelerisRequest, route: HaikuRoute): { effort: NonNullable<HaikuRoute['effort']>; thinking: Block } {
  if (request.tools?.length) return { effort: route.effort ?? 'medium', thinking: { type: 'adaptive' } };
  if (!request.thinking) return { effort: 'low', thinking: { type: 'disabled' } };
  return { effort: request.reasoningEffort === 'medium' || request.reasoningEffort === 'xhigh' ? 'high' : 'medium', thinking: { type: 'adaptive' } };
}

/**
 * Prompt caching only pays when a prefix is read back: a cache write costs
 * 1.25x ordinary input, a read 0.1x. A tool conversation is append-only, so
 * its automatic breakpoint is reused every turn. A one-off prompt is not; its
 * reusable part is the trusted instructions before the first untrusted data
 * block (rules, profile, guidance), shared by every job in a run. That prefix
 * gets its own block, and a breakpoint once it has been seen before, so a
 * prompt that never repeats never pays for a write.
 */
const MIN_CACHED_PREFIX_CHARS = 2048; // ~512 tokens, Haiku 5.5's minimum cacheable prompt
const seenPrefixes = new Map<string, true>();
function cacheRepeatedPrefix(messages: NativeMessage[], model: string): NativeMessage[] {
  const only = messages.length === 1 ? messages[0] : null;
  const text = only?.content.length === 1 && only.content[0].type === 'text' ? String(only.content[0].text) : '';
  const split = text.indexOf('\n<untrusted');
  if (split < MIN_CACHED_PREFIX_CHARS) return messages;
  const prefix = text.slice(0, split);
  const key = createHash('sha256').update(model).update('\0').update(prefix).digest('hex');
  const repeated = seenPrefixes.delete(key);
  seenPrefixes.set(key, true);
  if (seenPrefixes.size > 2000) seenPrefixes.delete(seenPrefixes.keys().next().value!);
  return [{ role: 'user', content: [
    { type: 'text', text: prefix, ...(repeated ? { cache_control: { type: 'ephemeral' } } : {}) },
    { type: 'text', text: text.slice(split) },
  ] }];
}

/** Strict tools need closed objects; an open one would only ever accept {}. */
function strictCompatible(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(strictCompatible);
  if (!object(schema)) return true;
  if ((schema.type === 'object' || schema.properties) && (!object(schema.properties) || schema.additionalProperties === true || object(schema.additionalProperties))) return false;
  if ('$ref' in schema) return false;
  return Object.values(schema).every(strictCompatible);
}
export const HAIKU_SCHEMA_LIMITS = { strictTools: 20, optionalParameters: 24, unionParameters: 16 } as const;
function schemaChildren(schema: Block): unknown[] {
  const children = ['properties', '$defs', 'definitions'].flatMap(key => object(schema[key]) ? Object.values(schema[key]) : []);
  for (const key of ['items', 'additionalProperties', 'not']) if (object(schema[key])) children.push(schema[key]);
  for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems']) if (Array.isArray(schema[key])) children.push(...schema[key]);
  return children;
}
export function haikuSchemaComplexity(schema: unknown): { optionalParameters: number; unionParameters: number } {
  if (!object(schema)) return { optionalParameters: 0, unionParameters: 0 };
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const result = { optionalParameters: object(schema.properties) ? Object.keys(schema.properties).filter(key => !required.has(key)).length : 0,
    unionParameters: Array.isArray(schema.type) || Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) ? 1 : 0 };
  for (const child of schemaChildren(schema)) {
    const nested = haikuSchemaComplexity(child); result.optionalParameters += nested.optionalParameters; result.unionParameters += nested.unionParameters;
  }
  return result;
}
function schemaBudgetTools(request: CelerisRequest, strict: boolean): Block[] {
  const total = haikuSchemaComplexity(request.responseSchema);
  if (total.optionalParameters > HAIKU_SCHEMA_LIMITS.optionalParameters || total.unionParameters > HAIKU_SCHEMA_LIMITS.unionParameters) {
    throw new HaikuConversationError('haiku-schema-budget', 'Haiku structured output exceeds the native schema budget; simplify the schema without dropping its validation.');
  }
  let strictCount = 0;
  return (request.tools ?? []).map(tool => {
    const base = { name: tool.name, description: tool.description, input_schema: tool.parameters };
    const cost = haikuSchemaComplexity(tool.parameters);
    if (!strict || !strictCompatible(tool.parameters) || strictCount >= HAIKU_SCHEMA_LIMITS.strictTools
      || total.optionalParameters + cost.optionalParameters > HAIKU_SCHEMA_LIMITS.optionalParameters
      || total.unionParameters + cost.unionParameters > HAIKU_SCHEMA_LIMITS.unionParameters) return base;
    strictCount++; total.optionalParameters += cost.optionalParameters; total.unionParameters += cost.unionParameters;
    return { ...base, input_schema: haikuSchema(tool.parameters), strict: true };
  });
}
function fingerprint(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().filter(key => v[key] !== undefined).map(key => [key, stable(v[key])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
type Protocol = { version: 'haiku-native-v1'; sourceTools: string; system: string; thinking: string; output: string; provider: string; model: string; tools: Block[] };
export class HaikuConversationError extends Error {
  readonly requiresFreshConversation = true;
  constructor(readonly code: 'haiku-conversation-changed' | 'haiku-history-metadata-missing' | 'haiku-schema-budget', message: string) { super(message); this.name = 'HaikuConversationError'; }
}
function previousProtocol(request: CelerisRequest): Protocol | undefined {
  const native = request.messages.filter((m): m is Extract<ChatMessage, { role: 'assistant' }> => m.role === 'assistant' && Boolean(m.anthropic_content));
  if (!native.length) return undefined;
  for (const message of native) {
    const p = message.anthropic_protocol;
    if (!object(p) || p.version !== 'haiku-native-v1' || !Array.isArray(p.tools) || !p.tools.every(object)) {
      throw new HaikuConversationError('haiku-history-metadata-missing', 'Stored Haiku history has no verified toolset metadata; start a fresh conversation from verified executor state.');
    }
  }
  return native.at(-1)!.anthropic_protocol as Protocol;
}
function protocolFor(request: CelerisRequest, route: HaikuRoute, body: Block): Protocol {
  return { version: 'haiku-native-v1', sourceTools: fingerprint([...(request.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name))),
    system: fingerprint(body.system), thinking: fingerprint(body.thinking), output: fingerprint(body.output_config), provider: route.provider,
    model: route.model, tools: structuredClone((body.tools ?? []) as Block[]) };
}

export function haikuBody(request: CelerisRequest, route: HaikuRoute, options: { strictTools?: boolean } = {}): Record<string, unknown> {
  if (!expectedModels.has(route.model)) throw new Error('Haiku route must select the pinned Claude Haiku 5.5 model');
  const transcript = haikuMessages(request.messages);
  const maxTokens = request.maxTokens ?? 8192;
  if (!finite(maxTokens) || maxTokens === 0) throw new Error('Invalid Haiku output token limit');
  if (request.responseSchema) validator(request.responseSchema);
  for (const tool of request.tools ?? []) validator(tool.parameters);
  const conversation = Boolean(request.tools?.length) || transcript.messages.length > 1;
  const { effort, thinking } = haikuReasoning(request, route);
  const body: Record<string, unknown> = {
    model: route.model, system: transcript.system,
    messages: conversation ? transcript.messages : cacheRepeatedPrefix(transcript.messages, route.model),
    max_tokens: Math.min(128000, Math.max(4096, maxTokens)),
    thinking, output_config: { effort,
      ...(request.responseSchema ? { format: { type: 'json_schema', schema: haikuSchema(request.responseSchema) } } : {}) },
    // Native automatic caching moves the breakpoint without rewriting stored thinking blocks.
    ...(conversation ? { cache_control: { type: 'ephemeral' } } : {}), stream: false,
  };
  if (request.tools?.length) {
    // Every tool remains available. Only the subset fitting native limits is strict.
    body.tools = schemaBudgetTools(request, options.strictTools !== false);
    // Forced calls skip adaptive thinking. The controller handles a plain-text turn.
    body.tool_choice = { type: 'auto' };
  }
  if (route.provider === 'OpenRouter') body.provider = {
    only: ['anthropic'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny',
  };
  if (!request.tools?.length) schemaBudgetTools(request, false);
  const previous = previousProtocol(request);
  if (previous) {
    const current = protocolFor(request, route, body);
    if (['sourceTools', 'system', 'thinking', 'output', 'provider', 'model'].some(key => previous[key as keyof Protocol] !== current[key as keyof Protocol]) || options.strictTools === false) {
      throw new HaikuConversationError('haiku-conversation-changed', 'Haiku conversation definitions changed; start a fresh conversation from verified executor state before changing tools or instructions.');
    }
    if (previous.tools.length) body.tools = structuredClone(previous.tools);
    else delete body.tools;
  }
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

export type HaikuProviderCode = 'grammar-compilation-rate-limit' | 'strict-schema-rejected' | 'history-prefix-mismatch'
  | 'rate-limit' | 'authentication' | 'credit-limit' | 'invalid-request' | 'upstream-error' | 'transport-error' | 'invalid-provider-response';
/** Only fixed categories and safe metadata escape the provider boundary. */
export class HaikuProviderError extends Error {
  readonly name = 'HaikuProviderError';
  constructor(readonly status: number, readonly code: HaikuProviderCode, readonly providerType: string,
    readonly retryAfterMs: number | null, readonly requestId: string | null, readonly requiresFreshConversation = false) {
    const detail = code === 'grammar-compilation-rate-limit' ? 'temporarily limited grammar compilation'
      : code === 'strict-schema-rejected' ? 'rejected strict tool schemas' : code === 'history-prefix-mismatch' ? 'rejected changed conversation history'
        : code === 'rate-limit' ? 'is rate limited' : code === 'authentication' ? 'rejected authentication'
          : code === 'credit-limit' ? 'has reached its credit or spend limit' : code === 'invalid-request' ? 'rejected the request'
            : code === 'transport-error' ? 'could not complete the connection' : code === 'invalid-provider-response' ? 'returned an invalid response' : 'is temporarily unavailable';
    super(`Haiku provider ${detail}${status ? ` (HTTP ${status})` : ''}; ${code}.`);
  }
}
function retryAfter(headers: Headers, now: number): number | null {
  const raw = headers.get('retry-after'); if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(raw); return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
function providerFailure(status: number, payload: Block, headers: Headers, now: number, signedHistory: boolean): HaikuProviderError {
  const error = object(payload.error) ? payload.error : {};
  // Inspect only to classify. Never retain provider text, raw metadata or payloads.
  let text = typeof error.message === 'string' ? error.message : '';
  const metadata = object(error.metadata) ? error.metadata : {};
  if (typeof metadata.raw === 'string') {
    try { const raw = JSON.parse(metadata.raw); const nested = raw?.error?.message ?? raw?.message; if (typeof nested === 'string') text += '\n' + nested; } catch { /* No raw text is exported. */ }
  }
  const types = new Set(['invalid_request_error', 'rate_limit_error', 'authentication_error', 'permission_error', 'not_found_error', 'overloaded_error', 'api_error']);
  const providerType = typeof error.type === 'string' && types.has(error.type) ? error.type : 'unknown';
  let code: HaikuProviderCode;
  if (/grammar compilation rate limit exceeded|compilation(?:s)? per minute|compilation.{0,50}rate limit/i.test(text)) code = 'grammar-compilation-rate-limit';
  else if (/(?:thinking|signature|block.binding|prefix).{0,100}(?:mismatch|invalid|changed)|(?:changed|mismatch).{0,100}(?:thinking|signature|prefix)/i.test(text)) code = 'history-prefix-mismatch';
  else if (status === 400 && (/(?:strict.{0,100}(?:not supported|unsupported|not available|invalid|rejected)|(?:unsupported|invalid).{0,60}strict|too many strict tools|schema is too complex for compilation)/i.test(text)
    || /tools(?:\.|\[)\d+.{0,100}(?:strict|input_schema)/i.test(text))) code = 'strict-schema-rejected';
  else if (status === 401 || status === 403) code = 'authentication';
  else if (status === 402 || /(?:specified|monthly|workspace).{0,60}(?:usage|spend).{0,30}limit|credit balance|insufficient.{0,20}credit/i.test(text)) code = 'credit-limit';
  else if (status === 429) code = 'rate-limit';
  else if (status >= 500) code = 'upstream-error'; else code = 'invalid-request';
  const id = headers.get('request-id') ?? headers.get('x-request-id') ?? payload.request_id;
  const requestId = typeof id === 'string' && /^req[_-][A-Za-z0-9_-]{1,150}$/.test(id) ? id : null;
  return new HaikuProviderError(status, code, providerType, retryAfter(headers, now), requestId,
    code === 'history-prefix-mismatch' || signedHistory && code === 'strict-schema-rejected');
}

interface HaikuTiming { now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number }

async function reportedCost(payload: Block, route: HaikuRoute, deadline: number, now = Date.now): Promise<number | null> {
  const usage = object(payload.usage) ? payload.usage : {};
  if (finite(usage.cost)) return usage.cost;
  if (route.provider !== 'OpenRouter') return null;
  const metadata = object(payload.openrouter_metadata) ? payload.openrouter_metadata : {};
  const id = [payload.id, metadata.generation_id].find(v => typeof v === 'string' && /^gen-[A-Za-z0-9_-]+$/.test(v));
  const left = deadline - now();
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

export async function haikuChat(request: CelerisRequest, route: HaikuRoute, timing: HaikuTiming = {}): Promise<CelerisReply> {
  if (!route.apiKey) throw new Error('The selected Haiku provider key is not configured');
  let body = haikuBody(request, route);
  const timeout = route.timeoutMs ?? 120000;
  if (!finite(timeout) || timeout < 1) throw new Error('Invalid Haiku request deadline');
  const now = timing.now ?? Date.now, sleep = timing.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const random = timing.random ?? Math.random;
  const deadline = now() + timeout, started = performance.now(), signedHistory = Boolean(previousProtocol(request));
  let lastError: unknown, grammarRetried = false, transportRetried = false, strictFallbackUsed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const endCost = beginCostRequest(route.provider, route.model);
    let costRecorded = false, signal: AbortSignal | undefined, delay: number | null = null;
    try {
      if (now() >= deadline) throw new Error('Haiku request deadline exceeded');
      if (request.meter?.exhausted) throw new Error('Haiku application model budget exhausted');
      signal = AbortSignal.timeout(Math.max(1, deadline - now()));
      const response = await fetch(route.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
          ...(route.provider === 'Anthropic' ? { 'x-api-key': route.apiKey } : {
            authorization: `Bearer ${route.apiKey}`, 'X-OpenRouter-Metadata': 'enabled',
            'HTTP-Referer': 'https://owtomate.com', 'X-Title': 'Owtomate Haiku native agent',
          }) }, body: JSON.stringify(body), signal,
      });
      const payload: Block = await response.json().catch(error => { if (response.ok) throw error; return {}; });
      const usage = haikuUsage(payload.usage as NativeUsage | undefined);
      const actual = await reportedCost(payload, route, deadline, now);
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
        throw providerFailure(response.status, payload, response.headers, now(), signedHistory);
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
        anthropic_content: structuredClone(blocks), anthropic_protocol: protocolFor(request, route, body) } };
    } catch (error) {
      if (!costRecorded) recordCost({ provider: route.provider, model: route.model, amountUsd: null, basis: 'unknown', detail: 'Native Messages request did not yield final usage; it may have incurred charges.' });
      lastError = error;
      const e = error as Error & { code?: string; cause?: { code?: string } };
      const timeoutError = Boolean(signal?.aborted && signal.reason?.name === 'TimeoutError') || ['TimeoutError', 'ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].some(code => [e.name, e.code, e.cause?.code].includes(code));
      const failure = error instanceof HaikuProviderError ? error : timeoutError || /fetch failed/i.test(e.message ?? '')
        ? new HaikuProviderError(0, 'transport-error', 'unknown', null, null)
        : error instanceof SyntaxError ? new HaikuProviderError(0, 'invalid-provider-response', 'unknown', null, null) : undefined;
      const strictToolCount = Array.isArray(body.tools) ? (body.tools as Block[]).filter(tool => tool.strict === true).length : 0;
      const strictSent = strictToolCount > 0;
      let retryKind: string | null = null;
      if (attempt < 3 && !request.meter?.exhausted) {
        if (failure?.code === 'grammar-compilation-rate-limit' && !grammarRetried) {
          delay = failure.retryAfterMs ?? 60000 + Math.floor(Math.max(0, Math.min(1, random())) * 1000);
          retryKind = 'grammar-cooldown'; grammarRetried = true;
        } else if (failure?.code === 'strict-schema-rejected' && strictSent && !signedHistory && !strictFallbackUsed) {
          body = haikuBody(request, route, { strictTools: false }); strictFallbackUsed = true; delay = 0; retryKind = 'initial-non-strict-tools';
        } else if (failure && !transportRetried && ['rate-limit', 'upstream-error', 'transport-error'].includes(failure.code)) {
          delay = failure.retryAfterMs ?? 1000; retryKind = 'transport'; transportRetried = true;
        }
      }
      if (delay !== null && deadline - now() <= delay + 1000) { delay = null; retryKind = 'deadline-insufficient'; }
      metric('model-error', performance.now() - started, { model: route.model, provider: route.provider, attempt: attempt + 1,
        status: failure?.status ?? null, errorCode: failure?.code ?? (error instanceof HaikuConversationError ? error.code : 'invalid-model-response'),
        providerType: failure?.providerType ?? 'unknown', requestId: failure?.requestId ?? null, retryAfterMs: failure?.retryAfterMs ?? null,
        retryKind, retryDelayMs: delay, signedHistory, strictToolCount });
      if (delay === null) throw failure ?? error;
      lastError = failure ?? error;
    } finally { endCost(); }
    // Retry model generation only; no browser action has been returned or run.
    await sleep(delay!);
  }
  throw lastError;
}
