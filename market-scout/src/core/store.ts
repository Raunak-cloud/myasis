import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence, EvidenceKind, SourceId } from './types.js';

/**
 * Append-only evidence log for one run. Every record is written as it is
 * collected, so a crash or a spent budget loses nothing already gathered and
 * `--resume` can report on a partial run.
 */
export class EvidenceStore {
  private readonly byId = new Map<string, Evidence>();
  private readonly file: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'evidence.jsonl');
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Evidence;
          if (!record || ['id', 'source', 'kind', 'url', 'title', 'text', 'author', 'publishedAt', 'query', 'collectedAt'].some((key) => typeof record[key as keyof Evidence] !== 'string') || !record.attributes || typeof record.attributes !== 'object' || Array.isArray(record.attributes) || !record.metrics || typeof record.metrics !== 'object' || Array.isArray(record.metrics)) continue;
          this.byId.set(record.id, record);
        } catch {
          // A line torn by a crash mid-write; the rest of the file is intact.
        }
      }
    }
  }

  /** Adds new items and refreshes metrics on items seen before. Returns how many were new. */
  add(items: Evidence[]): number {
    let added = 0;
    for (const item of items) {
      const known = this.byId.get(item.id);
      // Keep unavailable counts unavailable in the newest snapshot.
      // The append-only log retains previous observations for inspection.
      const merged = item;
      if (!known) added += 1;
      this.byId.set(item.id, merged);
      appendFileSync(this.file, `${JSON.stringify(merged)}\n`);
    }
    return added;
  }

  all(filter: { source?: SourceId; kind?: EvidenceKind } = {}): Evidence[] {
    return [...this.byId.values()].filter(
      (item) => (!filter.source || item.source === filter.source) && (!filter.kind || item.kind === filter.kind),
    );
  }

  get(id: string): Evidence | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  writeJson(name: string, value: unknown): string {
    const path = join(this.dir, name);
    writeFileSync(path, JSON.stringify(value, null, 2));
    return path;
  }
}

export function evidenceId(source: SourceId, key: string): string {
  return `${source}:${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
}

/** Fills the fields a source left out, so every record has the full shape. */
export function evidence(
  partial: Pick<Evidence, 'source' | 'kind' | 'url'> & Partial<Evidence> & { key?: string },
): Evidence {
  const { key, ...rest } = partial;
  return {
    id: evidenceId(partial.source, key ?? partial.url),
    title: '',
    text: '',
    author: '',
    publishedAt: '',
    attributes: {},
    query: '',
    collectedAt: new Date().toISOString(),
    ...rest,
    metrics: Object.fromEntries(Object.entries(rest.metrics ?? {}).filter(([, value]) => Number.isFinite(value))),
  };
}

/** "1.2K", "3,400", "2.5M" as shown on social platforms → a number. */
export function parseCount(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return Number.NaN;
  const match = /(-?[\d.,]+)\s*([kmb])?/i.exec(raw.replace(/\s/g, ''));
  if (!match) return Number.NaN;
  const base = Number(match[1].replace(/,/g, ''));
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? '').toLowerCase() as 'k' | 'm' | 'b'] ?? 1;
  return Math.round(base * scale);
}
