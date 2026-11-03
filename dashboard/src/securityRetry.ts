export const SECURITY_RETRY_DELAY_MS = 8 * 60 * 60_000;
export const SECURITY_RETRY_MESSAGE = 'To help protect your application and reduce repeated security blocks, retries are paused for 8 hours.';
export interface SecurityRetry { reason: 'site-security'; retryAt: string }

/** Classify a reported failed attempt, never a candidate's clearance or an ordinary sign-in question. */
export function isSiteSecurityFailure(detail: string): boolean {
  const security = /\bcaptcha\b|\banti[- ]bot\b|\bdatadome\b|\bcloudflare\b|\bsecurity (?:check|verification|challenge)\b/i;
  const failure = /\b(?:block(?:ed|er|ing|s)?|fail(?:ed|ure)?|unresolved|persists?|restricted)\b|could(?:n't| not)|cannot|can't|unable|not (?:completed|resolved|passed)/i;
  return /\baccess is temporarily restricted\b/i.test(detail) || detail.split(/[.;\n]|\bbut\b|\bhowever\b/i).some(clause =>
    security.test(clause) && failure.test(clause)
      && !/\b(?:captcha|security (?:check|verification|challenge))\b[^.;]*\b(?:passed|cleared|solved|completed successfully)\b/i.test(clause));
}

export function securityRetryAt(blockedAt: Date | string): string | null {
  const at = new Date(blockedAt).getTime();
  return Number.isFinite(at) ? new Date(at + SECURITY_RETRY_DELAY_MS).toISOString() : null;
}

export function securityRetryRemaining(retry: SecurityRetry | null | undefined, now = Date.now()): number {
  const at = retry ? Date.parse(retry.retryAt) : NaN;
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

export function securityRetryCountdown(milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
