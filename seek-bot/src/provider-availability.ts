import { createHash } from 'node:crypto';
import { applicationModelEnvironment, applicationModelIdentity } from './application-model.js';

/** A provider spending limit is not a malformed form or a transient outage. */
export class ProviderBudgetError extends Error {
  constructor(readonly provider: string, readonly scope: 'workspace' | 'organization') {
    super(`${provider} ${scope} API spending limit reached. Increase that limit in the provider console or wait for its reset. This run cannot continue with the selected model.`);
    this.name = 'ProviderBudgetError';
  }
}

// Shared dashboard helpers must not block another account's separate key.
// Expiry lets a long-lived server observe a raised limit; workers stop and
// the next run starts a fresh process. No credentials enter logs or disk.
const blocked = new Map<string, { until: number; error: ProviderBudgetError }>();
const identity = (provider: string, key: string) => `${provider}:${createHash('sha256').update(key).digest('hex')}`;
export function assertProviderReady(provider: string, key: string): void {
  const id = identity(provider, key), entry = blocked.get(id);
  if (!entry) return;
  if (Date.now() >= entry.until) { blocked.delete(id); return; }
  throw entry.error;
}
export function blockProviderBudget(provider: string, key: string, scope: 'workspace' | 'organization'): ProviderBudgetError {
  const error = new ProviderBudgetError(provider, scope);
  blocked.set(identity(provider, key), { until: Date.now() + 60_000, error });
  return error;
}
export function assertApplicationProviderReady(): void {
  const env = applicationModelEnvironment(), model = applicationModelIdentity(env);
  assertProviderReady(model.provider, (env[model.selection === 'haiku' ? 'ANTHROPIC_API_KEY' : 'CELERIS_API_KEY'] ?? '').trim());
}

/** Match documented structured errors; never echo arbitrary provider text. */
export function anthropicSpendLimit(status: number, detail: string): 'workspace' | 'organization' | null {
  if (status !== 400) return null;
  try {
    const error = JSON.parse(detail).error;
    if (error?.type !== 'invalid_request_error' || typeof error.message !== 'string') return null;
    if (/^You have reached your specified workspace API usage limits\b/i.test(error.message)) return 'workspace';
    if (/^You have reached your specified API usage limits\b/i.test(error.message)) return 'organization';
  } catch { /* Ordinary malformed-request handling stays unchanged. */ }
  return null;
}
