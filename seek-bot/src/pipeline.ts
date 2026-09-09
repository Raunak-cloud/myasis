import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

export const runId = randomUUID();
export function metric(stage: string, ms: number, extra: Record<string, unknown> = {}): void {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    appendFileSync(resolve(config.dataDir, 'pipeline-metrics.jsonl'), JSON.stringify({ runId, ts: new Date().toISOString(), stage, ms, ...extra }) + '\n');
  } catch { /* Metrics must never interrupt an application. */ }
}
export async function measured<T>(stage: string, action: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
  const started = performance.now();
  try { const result = await action(); metric(stage, performance.now() - started, { ...extra, ok: true }); return result; }
  catch (error) { metric(stage, performance.now() - started, { ...extra, ok: false }); throw error; }
}

export async function cachedAssessment<T>(input: unknown, compute: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const key = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const dir = resolve(config.dataDir, 'fit-cache');
  const path = resolve(dir, `${key}.json`);
  try {
    if (existsSync(path)) {
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      if (Date.now() - entry.at < 7 * 86400_000 && accept(entry.value)) { metric('fit-cache-hit', 0); return entry.value; }
    }
  } catch { /* Corrupt/stale cache entries are recomputed. */ }
  const value = await compute();
  if (accept(value)) {
    try {
      mkdirSync(dir, { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ at: Date.now(), value }));
      renameSync(temp, path);
    } catch { /* Cache persistence is optional. */ }
  }
  return value;
}

/** Extractive retrieval: retained passages stay verbatim and in source order. */
export function relevantEvidence(text: string, query: string, maxChars = 8000): string {
  if (text.length <= maxChars) return text;
  const terms = new Set((query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
  const chunks = text.match(/[\s\S]{1,700}(?:\s|$)/g) ?? [text];
  const ranked = chunks.map((body, index) => ({ body, index, score:
    (index === 0 ? 3 : 0) + [...new Set(body.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter(t => terms.has(t)).length,
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: typeof ranked = []; let budget = Math.max(0, maxChars - 100);
  for (const chunk of ranked) { if (chunk.body.length <= budget) { selected.push(chunk); budget -= chunk.body.length; } }
  return '[Selected verbatim passages; omitted text is not evidence of absence.]\n' + selected.sort((a,b) => a.index-b.index).map(c => c.body).join('\n[...]\n');
}
