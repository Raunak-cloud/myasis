/** Validate before dispatch, even for tools that are not grammar-constrained. */
export function validToolInput(value: unknown, schema: Record<string, unknown>, closedObjects = true): boolean {
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if ((schema.required as string[] | undefined)?.some(key => !(key in object))) return false;
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
