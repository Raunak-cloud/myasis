/** Inspection only. These helpers never retry, reject or change browser actions. */
export type HrBrowserStep = 'profile' | 'route' | 'launch' | 'new_page' | 'mailbox' | 'mailbox_reset' | 'gmail_navigation' | 'mailbox_ready' | 'mailbox_identity';
export interface HrBrowserFailure {
  step: HrBrowserStep;
  elapsedMs: number;
  category: string;
  errorName: string;
  errorCode?: string;
  message: string;
  browserLog?: string[];
}
const steps = new WeakMap<object, {step: HrBrowserStep; elapsedMs: number}>();

export async function hrBrowserStep<T>(step: HrBrowserStep, action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try { return await action(); }
  catch (failure) {
    const error = failure instanceof Object ? failure : new Error(String(failure));
    if (!steps.has(error)) steps.set(error, {step, elapsedMs: Math.max(0, Date.now() - started)});
    throw error;
  }
}

function safeMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\bBearer\s+[^\s,"'}]+/gi, 'Bearer [redacted]')
    .replace(/((?:password|passwd|token|api[_-]?key|secret|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/[^\s()<>"']+@[^\s()<>"']+/g, '[email]')
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/g, '[path]')
    .replace(/[A-Za-z0-9_.-]{32,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 700);
}

/** Keep the first original error line, not page contents, launch commands or
 * provider payloads. Inspect the complete error only to identify known failures. */
export function hrBrowserFailure(error: unknown): HrBrowserFailure | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 6 && current instanceof Object && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as {name?: unknown; message?: unknown; code?: unknown; cause?: unknown};
    const timing = steps.get(current);
    if (timing) {
      const message = typeof value.message === 'string' ? value.message : '';
      const errorCode = message.match(/net::(ERR_[A-Z_]+)/)?.[1]
        ?? (typeof value.code === 'string' && /^(?:ERR_[A-Z_]+|EAI_[A-Z_]+|E[A-Z]{2,15})$/.test(value.code) ? value.code : undefined);
      const category = /SingletonLock|ProcessSingleton|profile.*(?:in use|locked)|user data directory.*in use/i.test(message) ? 'profile_in_use'
        : /Missing X server|without.*XServer|\$DISPLAY|cannot open display/i.test(message) ? 'display_unavailable'
        : /ERR_(?:TUNNEL|PROXY)_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES/.test(message) ? 'proxy_connection_failed'
        : /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(message) || errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN' ? 'dns_failure'
        : /ERR_(?:CONNECTION|INTERNET|NETWORK|TIMED_OUT)|ECONNRESET|ECONNREFUSED/.test(message) ? 'connection_failed'
        : /executable.*(?:doesn't exist|not found)|ENOENT/i.test(message) ? 'browser_executable_missing'
        : /EACCES|permission denied/i.test(message) ? 'permission_denied'
        : /ENOMEM|out of memory/i.test(message) ? 'out_of_memory'
        : /Target.*closed|browser.*(?:closed|crash)|page.*crash/i.test(message) ? 'browser_closed'
        : /timeout|timed out|did not respond within/i.test(message) || value.name === 'TimeoutError' ? 'timeout'
        : 'unclassified_browser_error';
      const browserLog=timing.step==='launch'?message.split(/\r?\n/).filter(line=>/\[pid=\d+\]\[err\]/.test(line)).slice(0,6).map(safeMessage):[];
      return {...timing, category, errorName: ['Error','TimeoutError','BrowserOperationTimeout','GmailServiceError','AbortError','TypeError'].includes(String(value.name)) ? String(value.name) : 'Error',
        ...(errorCode ? {errorCode} : {}), ...(browserLog.length?{browserLog}:{}), message: safeMessage(message.split(/\r?\n/)[0] || 'No error message was provided.')};
    }
    current = value.cause;
  }
  return undefined;
}
