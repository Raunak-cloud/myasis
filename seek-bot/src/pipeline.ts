import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { withJobCost } from './cost-ledger.js';

const runId = randomUUID();
export function metric(stage: string, ms: number, extra: Record<string, unknown> = {}): void {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    appendFileSync(resolve(config.dataDir, 'pipeline-metrics.jsonl'), JSON.stringify({ runId, ts: new Date().toISOString(), browserMode: config.headless ? 'headless' : 'headed', stage, ms, ...extra }) + '\n');
  } catch { /* Metrics must never interrupt an application. */ }
}
export async function measured<T>(stage: string, action: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
  const started = performance.now();
  try { const result = await (typeof extra.jobId === 'string' ? withJobCost(extra.jobId, action) : action()); metric(stage, performance.now() - started, { ...extra, ok: true }); return result; }
  catch (error) { metric(stage, performance.now() - started, { ...extra, ok: false }); throw error; }
}

// Scope in-flight reuse by the absolute account cache path, just like disk
// reuse. Identical work racing in the discovery/review pipelines should make
// one provider request, never share answers between accounts.
const assessmentsInFlight = new Map<string, Promise<unknown>>();
export async function cachedAssessment<T>(input: unknown, compute: () => Promise<T>, accept: (value: T) => boolean, ttlMs = 7 * 86400_000): Promise<T> {
  const version = input && typeof input === 'object' ? (input as { version?: unknown }).version : undefined;
  const assessment = typeof version === 'string' ? version.slice(0, 80) : 'unspecified';
  const key = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const dir = resolve(config.dataDir, 'fit-cache');
  const path = resolve(dir, `${key}.json`);
  try {
    if (existsSync(path)) {
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      const age = Date.now() - entry.at;
      if (Number.isFinite(age) && age >= 0 && age < ttlMs && accept(entry.value)) { metric('fit-cache-hit', 0, { assessment }); return entry.value; }
    }
  } catch { /* Corrupt/stale cache entries are recomputed. */ }
  const pending = assessmentsInFlight.get(path);
  if (pending) {
    const value = await pending as T;
    if (accept(value)) { metric('assessment-inflight-hit', 0, { assessment }); return value; }
  }
  const task = (async () => {
    const value = await compute();
    if (accept(value)) {
      try {
        mkdirSync(dir, { recursive: true });
        const temp = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temp, JSON.stringify({ at: Date.now(), value }), { mode: 0o600 });
        renameSync(temp, path);
      } catch { /* Cache persistence is optional. */ }
    }
    return value;
  })();
  assessmentsInFlight.set(path, task);
  try { return await task; }
  finally { if (assessmentsInFlight.get(path) === task) assessmentsInFlight.delete(path); }
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
