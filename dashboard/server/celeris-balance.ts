import { createHash } from 'node:crypto';
import { readEnv } from './runner.js';

export interface CelerisCredit {
  status: 'ready' | 'disconnected' | 'unavailable';
  creditBalanceCents?: number;
  currency?: string;
  workspaceName?: string;
  checkedAt?: string;
  message?: string;
}

/** Celeris's read-only management API, separate from inference. Never returns
 * the account object, credential, API-key names, or a ledger-based estimate. */
export function createCelerisBalanceReader(
  environment: () => Record<string, string | undefined> = () => ({ ...readEnv(), ...process.env }),
  request: typeof fetch = fetch,
) {
  let cache: { key: string; expiresAt: number; result: CelerisCredit } | undefined;
  let pending: { key: string; promise: Promise<CelerisCredit> } | undefined;
  return async (): Promise<CelerisCredit> => {
    const env = environment(), token = env.CELERIS_MANAGEMENT_TOKEN?.trim(), workspace = env.CELERIS_BILLING_WORKSPACE_ID?.trim();
    if (!token || !workspace) return { status: 'disconnected', message: 'Connect Celeris billing access.' };
    const key = createHash('sha256').update(`${workspace}:${token}`).digest('hex');
    if (cache?.key === key && cache.expiresAt > Date.now()) return cache.result;
    if (pending?.key === key) return pending.promise;
    const promise = (async (): Promise<CelerisCredit> => {
      let result: CelerisCredit;
      try {
        const response = await request('https://console.celeris.ai/api/agent/context', {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000), redirect: 'error',
        });
        if (response.status === 401 || response.status === 403) result = { status: 'disconnected', message: 'Celeris access expired or was revoked. Reconnect billing access.' };
        else if (!response.ok) result = { status: 'unavailable', message: 'Celeris could not return its balance. Try refreshing shortly.' };
        else {
          const body = await response.json();
          if (body?.workspace?.id !== workspace) result = { status: 'unavailable', message: 'Celeris returned a different workspace. Reconnect the workspace used by Owtomate.' };
          else if (!Number.isSafeInteger(body?.balance?.creditBalanceCents) || !/^[A-Za-z]{3}$/.test(body?.balance?.currency ?? '')) {
            result = { status: 'unavailable', message: 'Celeris did not return a valid prepaid balance.' };
          } else result = { status: 'ready', creditBalanceCents: body.balance.creditBalanceCents,
            currency: body.balance.currency.toUpperCase(), workspaceName: String(body.workspace.name ?? workspace).slice(0, 160), checkedAt: new Date().toISOString() };
        }
      } catch { result = { status: 'unavailable', message: 'Could not reach Celeris to check the balance.' }; }
      cache = { key, result, expiresAt: Date.now() + (result.status === 'ready' ? 30_000 : 5000) };
      return result;
    })();
    pending = { key, promise };
    try { return await promise; }
    finally { if (pending?.promise === promise) pending = undefined; }
  };
}

export const celerisBalance = createCelerisBalanceReader();
