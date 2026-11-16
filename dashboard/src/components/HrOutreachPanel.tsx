import { useEffect, useState } from 'react';
import { fmtDateTime } from '../format';
import { HrOutreachActivity, hrPhaseLabel, type HrOutreachProgress } from './HrOutreachActivity';

export interface HrOutreachEmail {
  id: string;
  jobId: string;
  platform: string;
  title: string;
  company: string;
  status: 'queued' | 'researching' | 'sending' | 'sent' | 'skipped' | 'error' | 'unconfirmed';
  toEmail: string | null;
  subject: string | null;
  body: string | null;
  createdAt: string;
  sentAt: string | null;
  reason?: string | null;
  sourceUrl?: string | null;
  sourceKind?: 'public_page' | 'indexed_excerpt' | 'stored_vacancy' | null;
  sourceCheckedAt?: string | null;
  contactName?: string | null;
  phase?: 'queued' | 'researching' | 'writing' | 'sending' | 'checking' | null;
  sourceRunId?: string | null;
  lookupOutcome?: 'found' | 'no_contact' | 'company_unverified' | 'access_blocked' | 'temporarily_unavailable' | 'incomplete' | null;
  lookupCheckedAt?: string | null;
  lookupRetryAt?: string | null;
  contactReviewRequired?: boolean;
  contactReviewReason?: string | null;
  deliveryStatus?: 'unknown' | 'bounced' | null;
  deliveryReason?: string | null;
  deliveryCheckedAt?: string | null;
  deliveryFailedAt?: string | null;
  outreachAttempt?: number;
  retryOfId?: string | null;
}

const STATUS: Record<HrOutreachEmail['status'], { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'muted' },
  researching: { label: 'Finding contact', tone: 'info' },
  sending: { label: 'Sending email', tone: 'info' },
  sent: { label: 'Sent', tone: 'ok' },
  skipped: { label: 'Not sent', tone: 'muted' },
  error: { label: 'Could not send', tone: 'bad' },
  unconfirmed: { label: 'Delivery unconfirmed', tone: 'warn' },
};
const LOOKUP_OUTCOMES = {
  no_contact: { label: 'No public contact', tone: 'muted', reason: 'No public hiring or recruitment email was found.' },
  company_unverified: { label: 'Company unverified', tone: 'warn', reason: 'The company website or its connection to this vacancy could not be verified.' },
  access_blocked: { label: 'Access blocked', tone: 'warn', reason: 'The public contact source blocked access.' },
  temporarily_unavailable: { label: 'Search temporarily unavailable', tone: 'warn', reason: 'The contact search service is temporarily unavailable.' },
  incomplete: { label: 'Lookup incomplete', tone: 'warn', reason: 'The contact search finished before enough evidence was collected.' },
} as const;

/** Plain text preserves the exact message without rendering employer content as HTML. */
export function HrEmailMessage({ item }: { item: HrOutreachEmail }) {
  const baseStatus = STATUS[item.status] ?? { label: 'Pending', tone: 'muted' };
  const lookup = item.lookupOutcome && item.lookupOutcome in LOOKUP_OUTCOMES ? LOOKUP_OUTCOMES[item.lookupOutcome as keyof typeof LOOKUP_OUTCOMES] : null;
  const bounced = item.deliveryStatus === 'bounced';
  const status = bounced ? { label: 'Delivery failed', tone: 'bad' } : item.phase && !['sent', 'skipped', 'error'].includes(item.status) && !(item.status==='unconfirmed'&&item.phase==='queued')
    ? { label: hrPhaseLabel(item.phase), tone: 'info' }
    : item.status === 'error' && item.lookupRetryAt === null ? { label: 'Failed', tone: 'bad' }
      : lookup && ['skipped', 'error'].includes(item.status) ? lookup : baseStatus;
  const retryAt = item.lookupRetryAt && ['queued', 'error', 'unconfirmed'].includes(item.status) ? item.lookupRetryAt : null;
  const lookupReason = item.reason || lookup?.reason;
  const sourceCaption = item.contactReviewRequired ? 'Recorded source' : item.sourceKind === 'stored_vacancy' ? 'Saved job advertisement'
    : item.sourceKind === 'indexed_excerpt' ? 'Public search result' : 'Public contact source';
  return <article className="hr-email">
    <div className="hr-email-heading">
      <div className="minw"><strong>{item.title}</strong><div className="job-meta">{item.company}</div>
        {(item.outreachAttempt ?? 1) > 1 && <div className="job-meta">Retry attempt {item.outreachAttempt}</div>}
      </div>
      <div className="hr-email-badges"><span className={`badge ${status.tone}`}>{status.label}</span>
        {item.contactReviewRequired && <span className="badge warn">Contact needs review</span>}
      </div>
    </div>
    <dl className="hr-email-meta">
      {item.toEmail && <div><dt>To</dt><dd>{item.contactName && !item.contactReviewRequired ? `${item.contactName} · ` : ''}{item.toEmail}</dd></div>}
      <div><dt>{item.sentAt ? 'Sent' : 'Added'}</dt><dd>{fmtDateTime(item.sentAt ?? item.createdAt)}</dd></div>
      {item.subject && <div><dt>Subject</dt><dd>{item.subject}</dd></div>}
      {item.lookupCheckedAt && <div><dt>Last check</dt><dd>{fmtDateTime(item.lookupCheckedAt)}</dd></div>}
      {item.sourceCheckedAt && <div><dt>{item.sourceKind === 'stored_vacancy' ? 'Advertisement saved' : item.sourceKind === 'indexed_excerpt' ? 'Search result checked' : 'Source checked'}</dt><dd>{fmtDateTime(item.sourceCheckedAt)}</dd></div>}
      {bounced && item.deliveryFailedAt && <div><dt>Delivery failed</dt><dd>{fmtDateTime(item.deliveryFailedAt)}</dd></div>}
      {item.deliveryCheckedAt && <div><dt>Last delivery check</dt><dd>{fmtDateTime(item.deliveryCheckedAt)}</dd></div>}
      {retryAt && <div><dt>{item.status === 'unconfirmed' ? 'Earliest delivery check' : 'Earliest retry'}</dt><dd>{Date.parse(retryAt) > Date.now()
        ? `From ${fmtDateTime(retryAt)}`
        : item.status === 'unconfirmed' ? 'Waiting to check delivery' : 'Waiting to retry'}</dd></div>}
    </dl>
    {item.body && <details className="hr-email-content"><summary>{item.status === 'sent' ? 'View sent email' : 'View email'}</summary><div className="letter">{item.body}</div></details>}
    {lookupReason && item.status !== 'sent' && <p className="job-meta">{lookupReason}</p>}
    {item.status === 'error' && item.lookupRetryAt === null && <p className="job-meta">No automatic retry is scheduled.</p>}
    {(bounced || item.deliveryReason) && <p className="job-meta" role="note">{item.deliveryReason || 'The recipient’s mail service returned this email. It was not delivered.'}</p>}
    {item.contactReviewRequired && <p className="hr-contact-review" role="note">{item.contactReviewReason || 'This address has not been verified as the right hiring contact for this application.'}</p>}
    {item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl) && <a className="hr-contact-source" href={item.sourceUrl} target="_blank" rel="noreferrer">{sourceCaption} ↗</a>}
  </article>;
}

export function HrOutreachPanel({ items, loading, error, onRetry, hasMore, loadingMore, moreError, onLoadMore, progress }: {
  items: HrOutreachEmail[]; loading: boolean; error: string | null; onRetry: () => void;
  hasMore: boolean; loadingMore: boolean; moreError: string | null; onLoadMore: () => void;
  progress: HrOutreachProgress | null;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsRefresh, setSettingsRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setSettingsError(null);
    fetch('/api/hr-outreach/settings').then(async response => {
      const result = await response.json();
      if (!response.ok || typeof result.enabled !== 'boolean') throw new Error();
      if (active) setEnabled(result.enabled);
    }).catch(() => { if (active) setSettingsError('Could not load your email preference.'); });
    return () => { active = false; };
  }, [settingsRefresh]);
  async function changeEnabled(next: boolean) {
    if (saving || enabled === null) return;
    setSaving(true); setSettingsError(null);
    try {
      const response = await fetch('/api/hr-outreach/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
      const result = await response.json();
      if (!response.ok || typeof result.enabled !== 'boolean') throw new Error();
      setEnabled(result.enabled);
    } catch { setSettingsError('Could not save your email preference. Please try again.'); }
    finally { setSaving(false); }
  }
  return <div className="hr-outreach-panel">
    <HrOutreachActivity progress={progress} error={Boolean(error)} />
    <div className="card hr-outreach-preference">
      <label><input type="checkbox" checked={enabled === true} disabled={enabled === null || saving} onChange={event => void changeEnabled(event.target.checked)} /><strong>Email hiring teams after I apply</strong></label>
      <p className="job-meta">After your application run finishes, send a short introduction from your connected email account for new confirmed applications with a public hiring contact.</p>
      {enabled === null && !settingsError && <p className="job-meta" role="status">Loading your email preference…</p>}
      {saving && <p className="job-meta" role="status">Saving…</p>}
      {settingsError && <p className="job-meta" role="alert">{settingsError}</p>}
      {settingsError && enabled === null && <button className="btn btn-small" onClick={() => setSettingsRefresh(value => value + 1)}>Reload preference</button>}
    </div>
    {error ? <div className="card empty" role="alert"><p>{error}</p><button className="btn" onClick={onRetry}>Try again</button></div>
      : loading && !items.length ? <div className="card empty" role="status">Loading your HR emails…</div>
      : !items.length ? <div className="card empty"><div className="big">No HR emails yet</div><p>Emails and their status will appear here after you turn on hiring-team emails and submit a new application.</p></div>
      : <div className="card hr-email-list">{items.map(item => <HrEmailMessage key={item.id} item={item} />)}</div>}
    {!error && hasMore && <div className="hr-email-more"><button className="btn" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? 'Loading…' : 'Load older emails'}</button>{moreError && <p className="job-meta" role="alert">{moreError}</p>}</div>}
  </div>;
}
