/** A board snapshot may contain thousands of ads. Keep the backlog, but admit
 * only a small, source-balanced window to model triage at a time. Ordering is
 * advisory; no listing is rejected here and the full fit review still decides. */
export class ProgressiveTriage<T> {
  private groups = new Map<string, T[]>();
  private seen = new Set<string>();
  private cursor = 0;
  constructor(private readonly options: {
    key: (item: T) => string;
    group: (item: T) => string;
    compare: (a: T, b: T) => number;
  }) {}

  add(items: readonly T[]): void {
    for (const item of items) {
      const key = this.options.key(item);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const group = this.options.group(item);
      const queue = this.groups.get(group) ?? [];
      queue.push(item);
      this.groups.set(group, queue);
    }
    for (const queue of this.groups.values()) queue.sort(this.options.compare);
  }

  get size(): number {
    return [...this.groups.values()].reduce((count, queue) => count + queue.length, 0);
  }

  take(limit = 24): T[] {
    const queues = [...this.groups.values()];
    const result: T[] = [];
    if (!queues.length) return result;
    while (result.length < limit && queues.some(queue => queue.length)) {
      const queue = queues[this.cursor++ % queues.length];
      if (queue.length) result.push(queue.shift()!);
    }
    return result;
  }
}

/** Select independent sources fairly. Background work is restricted to API
 * adapters, so it can never navigate an application worker's browser page. */
export function progressiveSearchBatch<T extends { pages: number }>(streams: readonly T[], options: {
  available: (stream: T) => boolean;
  source: (stream: T) => string;
  api: (stream: T) => boolean;
  preferApi: boolean;
  apiOnly?: boolean;
}): T[] {
  const sourceRead = (stream: T) => streams.some(other => options.source(other) === options.source(stream) && other.pages > 0);
  const available = streams.filter(stream => options.available(stream) && (!options.apiOnly || options.api(stream)))
    .sort((a, b) => Number(sourceRead(a)) - Number(sourceRead(b)) || a.pages - b.pages
      || (options.preferApi ? Number(options.api(b)) - Number(options.api(a)) : 0));
  const first = available[0];
  if (!first) return [];
  return options.api(first)
    ? [first, ...available.filter(stream => options.api(stream) && options.source(stream) !== options.source(first)).slice(0, 1)]
    : [first];
}
