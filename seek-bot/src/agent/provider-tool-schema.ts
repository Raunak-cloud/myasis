import type { ToolSchema } from './celeris.js';

/** Advertise ordinary typed arguments. Keep simple required alternatives;
 * action-dependent rules stay in the canonical dispatcher, not prose. */
function providerParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  if (schema.type === 'object' && schema.properties && Array.isArray(schema.anyOf)
    && !schema.anyOf.every(branch => branch && typeof branch === 'object'
      && Object.keys(branch).length === 1 && Array.isArray(branch.required))) delete result.anyOf;
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
