import type { ToolSchema } from './celeris.js';

/** Advertise ordinary typed arguments. Conditional object rules remain in
 * the canonical dispatcher instead of becoming a second schema in prose. */
function providerParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  if (schema.type === 'object' && schema.properties && Array.isArray(schema.anyOf)) delete result.anyOf;
  if (schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties as Record<string, Record<string, unknown>>)
    .map(([name, value]) => [name, providerParameters(value)]));
  if (schema.items && typeof schema.items === 'object') result.items = providerParameters(schema.items as Record<string, unknown>);
  return result;
}

export function minimaxToolSchema(tool: ToolSchema): ToolSchema {
  return { ...tool, parameters: providerParameters(tool.parameters) };
}

/** No nested JSON string, coercion or inferred argument values. */
export function minimaxToolArguments(_tool: ToolSchema, wire: Record<string, unknown>): Record<string, unknown> {
  return wire;
}
