import { applicationModelEnvironment, applicationModelIdentity } from '../application-model.js';
import { HAIKU_ANSWER_POLICY } from '../application-answer-policy.js';
import { beginCostRequest, recordCost } from '../cost-ledger.js';
import { metric } from '../pipeline.js';
import { providerOutOfCredit } from '../run-health.js';
import { ReplyUnusableError, type CelerisRequest, type CelerisReply, type ToolSchema } from './celeris.js';

type Block = Record<string, unknown>;
type NativeMessage = { role: 'user' | 'assistant'; content: Block[] };

/** Convert the shared schemas to Anthropic's grammar subset without mutating
 * the originals. Constraints the grammar cannot express stay in the tool
 * description and are enforced against the original schema before dispatch.
 * Keep optional fields optional: making them required changes tool semantics. */
export function haikuSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(haikuSchema);
  if (!value || typeof value !== 'object') return value;
  const schema = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, haikuSchema(item)]));
  if (schema.type === 'object') schema.additionalProperties = false;
  // Both JSON output and strict tools use the same constrained grammar.
  // Move unsupported bounds to descriptions, as Anthropic's SDK does,
  // while validating replies against the untouched original schema below.
  const limits: string[] = [];
  const unsupported = schema.type === 'array' ? ['maxItems']
    : schema.type === 'string' ? ['minLength', 'maxLength']
      : schema.type === 'integer' || schema.type === 'number'
        ? ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] : [];
  for (const key of unsupported) {
    if (key in schema) { limits.push(`${key}: ${JSON.stringify(schema[key])}`); delete schema[key]; }
  }
  if (schema.type === 'array') {
    if (typeof schema.minItems === 'number' && schema.minItems > 1) {
      limits.push(`minItems: ${schema.minItems}`);
      schema.minItems = 1;
    }
  }
  if (limits.length) schema.description = [schema.description, `Additional requirements: ${limits.join('; ')}.`].filter(Boolean).join(' ');
  return schema;
}

function optionalCount(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const schema = value as { properties?: Record<string, unknown>; required?: string[] };
  return (schema.properties ? Object.keys(schema.properties).filter(key => !schema.required?.includes(key)).length : 0)
    + Object.values(value).reduce<number>((sum, item) => sum + optionalCount(item), 0);
}

/** Anthropic has shared grammar limits (20 strict tools / 24 optional fields).
 * Prioritise form writes; validate all calls locally as well. */
const STRICT_TOOLS = new Set(['answer_questions', 'choose_option', 'click', 'press_key', 'finish', 'attach_resume', 'add_cover_letter', 'complete_authentication']);
export function haikuTools(tools: ToolSchema[]): Block[] {
  let optional = 0;
  return tools.map(tool => {
    const count = optionalCount(tool.parameters);
    const strict = STRICT_TOOLS.has(tool.name) && optional + count <= 24;
    if (strict) optional += count;
    return { name: tool.name, description: tool.description, input_schema: haikuSchema(tool.parameters), ...(strict ? { strict: true } : {}) };
  });
}

/** Validate before dispatch, even for tools that are not grammar-constrained. */
export function validHaikuInput(value: unknown, schema: Record<string, unknown>, closedObjects = true): boolean {
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if ((schema.required as string[] | undefined)?.some(key => !(key in object))) return false;
    return Object.entries(object).every(([key, item]) => properties[key]
      ? validHaikuInput(item, properties[key], closedObjects) : !closedObjects && schema.additionalProperties !== false);
  }
  if (schema.type === 'array') return Array.isArray(value)
    && (typeof schema.minItems !== 'number' || value.length >= schema.minItems)
    && (typeof schema.maxItems !== 'number' || value.length <= schema.maxItems)
    && value.every(item => validHaikuInput(item, (schema.items ?? {}) as Record<string, unknown>, closedObjects));
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return false;
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false;
    if (typeof schema.multipleOf === 'number') {
      if (schema.multipleOf <= 0) return false;
      const ratio = value / schema.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > Number.EPSILON * Math.max(1, Math.abs(ratio)) * 4) return false;
    }
    return true;
  }
  if (schema.type === 'string') return typeof value === 'string'
    && (typeof schema.minLength !== 'number' || [...value].length >= schema.minLength)
    && (typeof schema.maxLength !== 'number' || [...value].length <= schema.maxLength);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return true;
}

function nativeConversation(request: CelerisRequest): { system: Block[]; messages: NativeMessage[] } {
  const system: Block[] = [];
  const messages: NativeMessage[] = [];
  const push = (role: NativeMessage['role'], content: Block[]) => {
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of request.messages) {
    if (message.role === 'system') {
      system.push({ type: 'text', text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) });
    } else if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]);
    } else if (message.role === 'assistant') {
      // Retain signed thinking, redacted thinking and tool blocks exactly.
      push('assistant', message.nativeContent ? structuredClone(message.nativeContent) : [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.tool_calls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
      ]);
    } else {
      push('user', typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(part.image_url.url);
        if (!match) throw new Error('Haiku screenshot must be an inline supported image.');
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
      }));
    }
  }
  return { system, messages };
}

export function haikuBody(request: CelerisRequest, effort: 'medium' | 'high'): Record<string, unknown> {
  const { system, messages } = nativeConversation(request);
  const tools = request.tools?.length ? haikuTools(request.tools) : undefined;
  // A stable reusable prefix only. One-off fit/letter/answer prompts are not
  // cached wholesale at the more expensive cache-write rate.
  system.push({ type: 'text', text: HAIKU_ANSWER_POLICY, ...(tools ? { cache_control: { type: 'ephemeral' } } : {}) });
  if (tools) tools[tools.length - 1].cache_control = { type: 'ephemeral' };
  return {
    model: 'claude-haiku-5-5', max_tokens: Math.max(request.maxTokens ?? 8192, 8192),
    thinking: { type: 'adaptive' },
    output_config: { effort, ...(!tools && request.responseSchema ? { format: { type: 'json_schema', schema: haikuSchema(request.responseSchema) } } : {}) },
    // Browser conversations grow without rewriting earlier turns. Automatic
    // caching reuses that prefix; one-off structured calls stay uncached.
    system, messages, ...(tools ? { tools, tool_choice: { type: 'auto' }, cache_control: { type: 'ephemeral' } } : {}),
  };
}

export function haikuUsage(usage: unknown): { prompt: number; cached: number; completion: number; amountUsd: number } | null {
  const u = usage as Record<string, unknown> | undefined;
  const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  const input = count(u.input_tokens), output = count(u.output_tokens), read = count(u.cache_read_input_tokens), write = count(u.cache_creation_input_tokens);
  const prompt = input + read + write;
  const multiplier = prompt > 100_000 ? 5 : 1;
  return { prompt, cached: read, completion: output,
    amountUsd: multiplier * (input * 0.10 + output * 0.50 + read * 0.01 + write * 0.125) / 1_000_000 };
}

export async function haikuChat(request: CelerisRequest): Promise<CelerisReply> {
  const env = applicationModelEnvironment(), key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY is required for Haiku.');
  let effort: 'medium' | 'high' = request.reasoningEffort === 'xhigh' ? 'high' : 'medium';
  const deadline = Date.now() + 120_000, started = performance.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const end = beginCostRequest('Anthropic', 'claude-haiku-5-5');
    let accounted = false;
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(haikuBody(request, effort)), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        if (response.status === 402 || /credit balance is too low|insufficient.*credit/i.test(detail)) providerOutOfCredit('Anthropic');
        throw new Error(`Haiku provider HTTP ${response.status}.`);
      }
      const payload = await response.json() as { content?: Block[]; stop_reason?: string; usage?: unknown };
      const usage = haikuUsage(payload.usage);
      if (usage) request.meter?.recordProvider(usage);
      recordCost({ provider: 'Anthropic', model: 'claude-haiku-5-5', amountUsd: usage?.amountUsd ?? null, basis: usage ? 'estimated' : 'unknown',
        detail: usage ? `${usage.prompt} input (${usage.cached} cache read), ${usage.completion} output tokens including thinking; published USD rates 2026-10-18; effort=${effort}.` : 'Usage unavailable.' });
      accounted = true;
      if (payload.stop_reason === 'refusal') throw new Error('Haiku declined this request; no browser action ran.');
      const content = payload.content ?? [];
      const text = content.filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('');
      const toolCalls = content.filter(block => block.type === 'tool_use').map(block => {
        const tool = request.tools?.find(tool => tool.name === block.name);
        const valid = tool && validHaikuInput(block.input, tool.parameters);
        return { id: String(block.id), name: String(block.name), args: valid ? block.input as Record<string, unknown> : { __parseError: 'Tool arguments did not match the declared schema; correct them before any action.' } };
      });
      if (payload.stop_reason === 'max_tokens' || (!text && !toolCalls.length) || (request.requireTool && !toolCalls.length)) {
        throw new ReplyUnusableError('Haiku did not return a complete actionable response.');
      }
      if (request.responseSchema && !request.tools?.length) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw new ReplyUnusableError('Haiku returned invalid structured output.'); }
        if (!validHaikuInput(parsed, request.responseSchema, false)) throw new ReplyUnusableError('Haiku structured output did not satisfy the original response schema.');
      }
      metric('model', performance.now() - started, { model: applicationModelIdentity().model, attempts: attempt + 1, effort, usage: payload.usage });
      return { text, toolCalls, message: { role: 'assistant', content: text || null, nativeContent: content,
        tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } };
    } catch (error) {
      if (!accounted) recordCost({ provider: 'Anthropic', model: 'claude-haiku-5-5', amountUsd: null, basis: 'unknown', detail: 'Request failed without usage; final charge unavailable.' });
      if (Date.now() >= deadline || attempt === 2) throw error;
      if (error instanceof ReplyUnusableError && effort === 'medium') { effort = 'high'; continue; }
      if (!/HTTP (429|5\d\d)|fetch failed|ECONNRESET|timeout/i.test((error as Error).message)) throw error;
      await new Promise(done => setTimeout(done, 500 * 2 ** attempt));
    } finally { end(); }
  }
  throw new Error('Haiku request failed.');
}
