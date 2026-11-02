import type { ToolSchema } from './celeris.js';

function hasConditionalObject(schema: Record<string, unknown>): boolean {
  if (schema.type === 'object' && schema.properties && Array.isArray(schema.anyOf)) return true;
  return Object.values((schema.properties ?? {}) as Record<string, Record<string, unknown>>).some(hasConditionalObject)
    || Boolean(schema.items && typeof schema.items === 'object' && hasConditionalObject(schema.items as Record<string, unknown>));
}

/** MiniMax's tool grammar can lose nested values when a schema combines its
 * property catalogue with conditional anyOf branches. Serialize only those
 * complex contracts, as already done for helper definitions. The decoded
 * object must still pass the unchanged canonical validator before dispatch.
 * No coercion, JSON repair, action execution or retry happens in transport. */
export function minimaxToolSchema(tool: ToolSchema): ToolSchema {
  if (!hasConditionalObject(tool.parameters)) return tool;
  return { ...tool,
    description: `${tool.description}\nProvide arguments_json as one serialized JSON object, preserving every nested value exactly. `
      + `The decoded object must conform to this full argument contract before execution: ${JSON.stringify(tool.parameters)}`,
    parameters: { type: 'object', additionalProperties: false,
      properties: { arguments_json: { type: 'string',
        description: 'The complete tool argument object encoded as valid JSON text, preserving all nested properties and literal values.' } },
      required: ['arguments_json'] },
  };
}

export function minimaxToolArguments(tool: ToolSchema, wire: Record<string, unknown>): Record<string, unknown> {
  if (!hasConditionalObject(tool.parameters)) return wire;
  const invalid = { __parseError: 'arguments_json must be valid JSON text encoding one object and no extra outer fields. No tool operation ran; correct the JSON before trying again.' };
  if (!wire || typeof wire !== 'object' || Array.isArray(wire) || Object.keys(wire).length !== 1
    || typeof wire.arguments_json !== 'string' || wire.arguments_json.length > 1000000) return invalid;
  try {
    const decoded = JSON.parse(wire.arguments_json);
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : invalid;
  } catch { return invalid; }
}
