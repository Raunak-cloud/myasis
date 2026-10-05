/**
 * Finds records inside JSON whose wrapper shape is unknown or changes.
 *
 * Social sites ship their data as JSON — GraphQL responses, embedded
 * hydration blobs — nested under keys that are renamed between releases.
 * Selecting records by what they *are* (an object carrying `ad_archive_id`,
 * a video with `stats`) rather than where they sit keeps a source working
 * across those renames. Fields are then read by path, with fallbacks.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Every object in `root` (depth-first) for which `isRecord` is true. Matched objects are not searched inside. */
export function findRecords(root: unknown, isRecord: (node: Record<string, unknown>) => boolean, limit = 5_000): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length && found.length < limit) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    const object = node as Record<string, unknown>;
    if (isRecord(object)) {
      found.push(object);
      continue;
    }
    const values = Object.values(object);
    for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
  }
  return found;
}

/** Reads the first path that yields a value: pick(ad, 'snapshot.body.text', 'body'). */
export function pick(node: unknown, ...paths: string[]): unknown {
  for (const path of paths) {
    let value: unknown = node;
    for (const key of path.split('.')) {
      if (value === null || value === undefined) break;
      value = Array.isArray(value) && /^\d+$/.test(key) ? value[Number(key)] : (value as Record<string, unknown>)[key];
    }
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export const pickString = (node: unknown, ...paths: string[]): string => {
  const value = pick(node, ...paths);
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
};

export const pickNumber = (node: unknown, ...paths: string[]): number => {
  const value = pick(node, ...paths);
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return Number.NaN;
};

/** Unix seconds or milliseconds, or an ISO-ish string → ISO date, else "". */
export function toIsoDate(value: unknown): string {
  if (typeof value === 'number' && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return toIsoDate(asNumber);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return '';
}

/**
 * Parses a response body that may carry an anti-JSON-hijacking prefix
 * (`for (;;);`, `)]}'`) or several JSON documents on separate lines, as
 * Facebook's streamed GraphQL does.
 */
export function parseLooseJson(body: string): unknown[] {
  const cleaned = body.replace(/^\s*(?:for\s*\(;;\);|\)\]\}'?,?)/, '');
  try {
    return [JSON.parse(cleaned)];
  } catch {
    const docs: unknown[] = [];
    for (const line of cleaned.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
      try {
        docs.push(JSON.parse(trimmed));
      } catch {
        // Not every line of a mixed stream is JSON.
      }
    }
    return docs;
  }
}
