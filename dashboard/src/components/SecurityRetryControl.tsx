import { fmtDateTime } from '../format';
import { SECURITY_RETRY_MESSAGE, securityRetryCountdown, securityRetryRemaining, type SecurityRetry } from '../securityRetry';

/** Shared by the real prepared application and the admin's read-only simulation. */
export function SecurityRetryControl({ retry, now, disabled, onRetry }: {
  retry?: SecurityRetry | null; now: number; disabled?: boolean; onRetry: () => void;
}) {
  const remaining = securityRetryRemaining(retry, now);
  return <div className="prepared-retry-control">
    {remaining > 0 && retry && <div className="security-retry-notice">
      <p>{SECURITY_RETRY_MESSAGE}</p>
      <p className="job-meta">Retry available <time dateTime={retry.retryAt}>{fmtDateTime(retry.retryAt)}</time></p>
    </div>}
    <button type="button" className="btn prepared-retry" disabled={disabled || remaining > 0} onClick={onRetry}>
      {remaining > 0 ? `Retry in ${securityRetryCountdown(remaining)}` : 'Retry application'}
    </button>
  </div>;
}
