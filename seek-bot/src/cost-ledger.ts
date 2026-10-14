import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

/** Usage only: never prompts, credentials, answers or page contents. */
export interface CostEvent {
  id: string; runId: string; at: string; jobId?: string;
  kind: 'usage' | 'submitted' | 'started' | 'finished';
  provider?: string; model?: string; amountUsd?: number | null;
  basis?: 'provider' | 'estimated' | 'unknown';
  detail?: string; quantity?: number; unit?: string;
}
const scope = new AsyncLocalStorage<string>();
const runId = randomUUID();
let started = false;
let warned = false;
const pending = new Map<string, { provider: string; model?: string; jobId?: string }>();
export const COST_LEDGER_FILE = 'cost-ledger.jsonl';
export const CELERIS_RATES = { promptUncached: 0.2, promptCached: 0.02, completion: 0.7 } as const;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function withJobCost<T>(jobId: string, action: () => T): T { return scope.run(jobId, action); }
export function configuredRate(name: string): number | null {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return finite(value) ? value : null;
}
export function appendCostEvent(event: Omit<CostEvent, 'id' | 'runId' | 'at'>): void {
  // Instrumentation never interrupts a real application. A failed write is visible.
  try {
    mkdirSync(config.dataDir, { recursive: true });
    appendFileSync(resolve(config.dataDir, COST_LEDGER_FILE), JSON.stringify({
      id: randomUUID(), runId, at: new Date().toISOString(), jobId: scope.getStore(), ...event,
    }) + '\n', { mode: 0o600 });
  } catch {
    if (!warned) { warned = true; console.warn('Cost recording unavailable; application costs may be incomplete.'); }
  }
}
function start(): void {
  if (started) return;
  started = true;
  appendCostEvent({ kind: 'started' });
  process.once('exit', () => {
    for (const request of pending.values()) appendCostEvent({ ...request, kind: 'usage', amountUsd: null, basis: 'unknown', detail: 'Process ended with a provider request in flight; final charge unavailable.' });
    const hours = process.uptime() / 3600;
    const rate = configuredRate('APPLICATION_INFRA_USD_PER_WORKER_HOUR');
    appendCostEvent({ kind: 'usage', jobId: undefined, provider: 'Infrastructure',
      amountUsd: rate === null ? null : hours * rate, basis: rate === null ? 'unknown' : 'estimated',
      quantity: hours, unit: 'worker hours', detail: rate === null
        ? 'Hosting, proxy and fixed service overhead not allocated; configure an all-in worker-hour rate.'
        : `Allocated hosting, proxy and fixed service overhead at US$${rate}/worker-hour; excludes separately metered providers.` });
    appendCostEvent({ kind: 'finished', jobId: undefined });
  });
}
/** Keeps fatal exits from silently losing requests that may already be billed. */
export function beginCostRequest(provider: string, model?: string): () => void {
  if (process.env.COST_TRACKING !== 'true') return () => {};
  start();
  const id = randomUUID();
  pending.set(id, { provider, model, jobId: scope.getStore() });
  return () => { pending.delete(id); };
}
export function recordCost(event: Omit<CostEvent, 'id' | 'runId' | 'at' | 'kind'>): void {
  if (process.env.COST_TRACKING !== 'true') return;
  start();
  appendCostEvent({ ...event, kind: 'usage' });
}
export function recordSubmittedCost(jobId: string): void {
  if (process.env.COST_TRACKING !== 'true') return;
  start(); appendCostEvent({ kind: 'submitted', jobId });
}

export function celerisUsage(usage: unknown): { prompt: number; cached: number; completion: number; amountUsd: number } | null {
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } | null;
  if (!u || !finite(u.prompt_tokens) || !finite(u.completion_tokens)) return null;
  const prompt = u.prompt_tokens;
  const cached = Math.min(prompt, finite(u.prompt_tokens_details?.cached_tokens) ? u.prompt_tokens_details.cached_tokens : 0);
  const completion = u.completion_tokens;
  return { prompt, cached, completion, amountUsd: ((prompt - cached) * CELERIS_RATES.promptUncached + cached * CELERIS_RATES.promptCached + completion * CELERIS_RATES.completion) / 1_000_000 };
}
export function recordCelerisCost(model: string, usage: unknown): void {
  const u = celerisUsage(usage);
  recordCost({ provider: 'Celeris', model, amountUsd: u?.amountUsd ?? null, basis: u ? 'estimated' : 'unknown',
    detail: u ? `${u.prompt} input tokens (${u.cached} cached), ${u.completion} output tokens including reasoning; published USD rates 2026-10-14.`
      : 'Request usage unavailable; charge cannot be determined.' });
}

/** Use provider session bytes, never page sizes or account-wide balance deltas. */
export async function recordBrightDataCost(sessionId?: string): Promise<void> {
  if (process.env.COST_TRACKING !== 'true') return;
  const rate = configuredRate('BRIGHTDATA_BROWSER_USD_PER_GB') ?? 8;
  try {
    if (!sessionId || !process.env.BRIGHTDATA_API_KEY) throw new Error('unavailable');
    const response = await fetch(`https://api.brightdata.com/browser_sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error('unavailable');
    const { session } = await response.json() as { session?: { session_id?: string; bandwidth?: unknown; status?: string } };
    if (session?.session_id !== sessionId || !finite(session.bandwidth) || !['finished', 'failed'].includes(session.status ?? '')) throw new Error('unavailable');
    recordCost({ provider: 'Bright Data', amountUsd: session.bandwidth / 1_000_000_000 * rate, basis: 'estimated',
      quantity: session.bandwidth, unit: 'bytes', detail: `Provider session bandwidth at US$${rate}/GB; before credits, tax and premium-domain adjustments.` });
  } catch {
    recordCost({ provider: 'Bright Data', amountUsd: null, basis: 'unknown',
      detail: 'Final session bandwidth unavailable; requires BRIGHTDATA_API_KEY and provider session data. Browser connection may have incurred charges.' });
  }
}
