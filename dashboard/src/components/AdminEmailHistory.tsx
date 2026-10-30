import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../adminApi';
import type { AdminEmailHistoryPage } from '../admin-email-history';

const sentTime = (iso: string) => new Intl.DateTimeFormat('en-AU', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Sydney',
}).format(new Date(iso));

export function AdminEmailHistory({ userId }: { userId: string }) {
  return <EmailHistory key={userId} userId={userId} />;
}
function EmailHistory({ userId }: { userId: string }) {
  const [history, setHistory] = useState<AdminEmailHistoryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (cursor?: string) => {
    const signal = controller.current?.signal;
    setBusy(true); setError('');
    try {
      const page = await api<AdminEmailHistoryPage>(`/users/${userId}/email-history${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`, { signal });
      if (signal?.aborted) return;
      setHistory(current => ({ items: cursor && current ? [...new Map([...current.items, ...page.items].map(item => [item.id, item])).values()] : page.items,
        nextCursor: page.nextCursor }));
    } catch (reason) {
      if (!signal?.aborted) setError((reason as Error).message);
    } finally { if (!signal?.aborted) setBusy(false); }
  }, [userId]);
  useEffect(() => {
    controller.current = new AbortController();
    const pending = controller.current;
    void (async () => { await load(); })();
    return () => pending.abort();
  }, [load]);

  return <section className="admin-email-history" aria-label="Sent email history">
    <h3>Sent email history</h3>
    <p className="job-meta">Emails sent from the admin email tool. Times are shown in Sydney time.</p>
    {busy && !history && <p role="status">Loading sent emails…</p>}
    {error && <div className="banner banner-bad" role="alert">Could not load sent emails. {error}{' '}
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => void load(history?.nextCursor ?? undefined)}>Try again</button></div>}
    {history?.items.length === 0 && <p className="job-meta">No emails have been sent from this admin tool to this user yet.</p>}
    {Boolean(history?.items.length) && <div className="admin-email-history-list">
      {history!.items.map(mail => <details key={mail.id}>
        <summary><strong>{mail.subject}</strong><span className="job-meta"><time dateTime={mail.sentAt}>{sentTime(mail.sentAt)}</time></span></summary>
        <p className="job-meta">Sent by {mail.sentBy ? `${mail.sentBy.name ? `${mail.sentBy.name} · ` : ''}${mail.sentBy.email}` : 'an administrator (name not recorded)'}</p>
        <div className="admin-email-history-message">{mail.body}</div>
      </details>)}
    </div>}
    {history?.nextCursor && <button type="button" className="btn btn-small" disabled={busy} onClick={() => void load(history.nextCursor!)}>
      {busy ? 'Loading…' : 'Load older emails'}</button>}
  </section>;
}
