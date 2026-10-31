/** Validate before dispatch, even for tools that are not grammar-constrained. */
export function validToolInput(value: unknown, schema: Record<string, unknown>, closedObjects = true): boolean {
  // Branches can require alternative properties without redeclaring the
  // parent's closed property catalogue. The same contract goes to the model
  // and is checked locally before dispatch.
  if (value && typeof value === 'object' && !Array.isArray(value)
    && (schema.required as string[] | undefined)?.some(key => !(key in value))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(branch => validToolInput(value, branch as Record<string, unknown>, closedObjects))) return false;
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    return Object.entries(object).every(([key, item]) => properties[key]
      ? validToolInput(item, properties[key], closedObjects) : !closedObjects && schema.additionalProperties !== false);
  }
  if (schema.type === 'array') return Array.isArray(value)
    && (typeof schema.minItems !== 'number' || value.length >= schema.minItems)
    && (typeof schema.maxItems !== 'number' || value.length <= schema.maxItems)
    && value.every(item => validToolInput(item, (schema.items ?? {}) as Record<string, unknown>, closedObjects));
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

/** Explain the failed contract without echoing candidate answers or secrets.
 * Validation and browser behaviour stay unchanged; the agent corrects its call. */
export function toolInputIssue(value: unknown, schema: Record<string, unknown>, path = '$'): string | null {
  if (validToolInput(value, schema)) return null;
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const missing = (schema.required as string[] | undefined)?.find(key => !(key in object));
    if (missing) return `${path}.${missing} is required.`;
    const unknown = Object.keys(object).filter(key => !properties[key]);
    if (unknown.length) return `${path} contains undeclared properties: ${unknown.map(key => JSON.stringify(key)).join(', ')}. Allowed: ${Object.keys(properties).join(', ')}. This tool call did not run; remove the undeclared properties or use the documented structure.`;
    for (const [key, item] of Object.entries(object)) {
      const issue = toolInputIssue(item, properties[key], `${path}.${key}`);
      if (issue) return issue;
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} must contain ${schema.minItems ?? 0} to ${schema.maxItems ?? 'the allowed number of'} items.`;
    for (const [index, item] of value.entries()) {
      const issue = toolInputIssue(item, (schema.items ?? {}) as Record<string, unknown>, `${path}[${index}]`);
      if (issue) return issue;
    }
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(branch => validToolInput(value, branch as Record<string, unknown>))) {
    const alternatives = schema.anyOf.map(branch => ((branch as Record<string, unknown>).required as string[] | undefined)
      ?.map(key => `${path}.${key}`).join(' and ')).filter(Boolean);
    return `${path} must supply ${alternatives.length ? `at least one supported alternative: ${alternatives.join(' or ')}` : 'one complete supported alternative'}. This tool call did not run; supply the missing arguments before retrying.`;
  }
  const constraints = Object.fromEntries(['type', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].filter(key => key in schema).map(key => [key, schema[key]]));
  return `${path} must match ${JSON.stringify(constraints)}. This tool call did not run; correct this argument.`;
}
