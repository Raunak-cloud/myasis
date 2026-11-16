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
  contactName?: string | null;
  phase?: 'queued' | 'researching' | 'writing' | 'sending' | 'checking' | null;
  sourceRunId?: string | null;
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

/** Plain text preserves the exact message without rendering employer content as HTML. */
export function HrEmailMessage({ item }: { item: HrOutreachEmail }) {
  const baseStatus = STATUS[item.status] ?? { label: 'Pending', tone: 'muted' };
  const status = item.phase && !['sent', 'skipped', 'error'].includes(item.status) && !(item.status==='unconfirmed'&&item.phase==='queued')
    ? { label: hrPhaseLabel(item.phase), tone: 'info' } : baseStatus;
  return <article className="hr-email">
    <div className="hr-email-heading">
      <div className="minw"><strong>{item.title}</strong><div className="job-meta">{item.company}</div></div>
      <span className={`badge ${status.tone}`}>{status.label}</span>
    </div>
    <dl className="hr-email-meta">
      {item.toEmail && <div><dt>To</dt><dd>{item.contactName ? `${item.contactName} · ` : ''}{item.toEmail}</dd></div>}
      <div><dt>{item.sentAt ? 'Sent' : 'Added'}</dt><dd>{fmtDateTime(item.sentAt ?? item.createdAt)}</dd></div>
      {item.subject && <div><dt>Subject</dt><dd>{item.subject}</dd></div>}
    </dl>
    {item.body && <details className="hr-email-content"><summary>{item.status === 'sent' ? 'View sent email' : 'View email'}</summary><div className="letter">{item.body}</div></details>}
    {item.reason && item.status !== 'sent' && <p className="job-meta">{item.reason}</p>}
    {item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl) && <a className="hr-contact-source" href={item.sourceUrl} target="_blank" rel="noreferrer">Public contact source ↗</a>}
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
