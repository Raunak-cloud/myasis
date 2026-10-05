import { useCallback, useEffect, useState } from 'react';
import { api } from '../adminApi';
import { StackedTable } from './StackedTable';

/**
 * The weekly job-market brief: what has gone up, what failed, and the
 * controls to hide a post, rewrite the weekly brief, or publish an extra post.
 * Writing, fact-checking and publishing all happen on the server.
 */

interface BlogReport {
  enabled: boolean;
  configured: boolean;
  humanizerConfigured: boolean;
  humanizerModel: string | null;
  model: string | null;
  currentWeek: string;
  writing: boolean;
  posts: Array<{ id: string; kind: 'weekly' | 'extra'; week: string; slug: string; title: string; url: string; hidden: boolean; publishedAt: string; updatedAt: string; humanizedAt: string | null; humanizerModel: string | null; revisions: number; unavailable: string[] }>;
  attempts: Array<{ kind: 'weekly' | 'extra'; week: string; attempts: number; lastAttemptAt: string | null; lastError: string | null }>;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function BlogView() {
  const [report, setReport] = useState<BlogReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<BlogReport>('/blog').then(setReport).catch((reason) => setError((reason as Error).message));
  }, []);
  useEffect(() => {
    load();
    // Faster while a post is being written, so the result shows up soon after it lands.
    const id = window.setInterval(load, report?.writing ? 5_000 : 30_000);
    return () => window.clearInterval(id);
  }, [load, report?.writing]);

  function write(replace: boolean, additional = false) {
    setBusy(true);
    setError(null);
    api('/blog/write', { method: 'POST', json: { replace, additional } })
      .then(() => { setReport((current) => current && { ...current, writing: true }); load(); })
      .catch((reason) => setError((reason as Error).message))
      .finally(() => setBusy(false));
  }

  function setHidden(id: string, hidden: boolean) {
    setError(null);
    api<BlogReport>(`/blog/${id}`, { method: 'PATCH', json: { hidden } })
      .then(setReport)
      .catch((reason) => setError((reason as Error).message));
  }

  if (!report) return <div className="admin-stack">{error ? <div className="banner banner-bad">{error}</div> : <p className="job-meta">Loading…</p>}</div>;

  const thisWeek = report.posts.find((post) => post.week === report.currentWeek && post.kind === 'weekly');
  const thisWeekAttempt = report.attempts.find((attempt) => attempt.week === report.currentWeek);

  return (
    <div className="admin-stack">
      {!report.configured ? (
        <div className="banner banner-bad">Add a Gemini API key under Config → Weekly blog.</div>
      ) : !report.humanizerConfigured ? (
        <div className="banner banner-bad">Configure Featherless under Config → Humanizer. All blogs require humanizing before publication.</div>
      ) : report.writing ? (
        <div className="banner">Writing a blog — researching, drafting, fact-checking, humanizing, then checking the final article before publishing. This takes a few minutes.</div>
      ) : thisWeekAttempt?.lastError ? (
        <div className="banner banner-bad">{thisWeekAttempt.kind === 'extra' ? 'Extra blog' : 'Weekly brief'} failed ({thisWeekAttempt.attempts} tries this week): {thisWeekAttempt.lastError}</div>
      ) : (
        <div className="banner banner-ok">{thisWeek ? 'This week’s brief is published.' : report.enabled ? 'This week’s brief goes up from 6am Monday.' : 'Ready to write a blog.'} Writer: Gemini ({report.model}). Humanizer: {report.humanizerModel} (required).</div>
      )}
      {!report.enabled && <div className="banner">Weekly publishing is off (Config → Weekly blog). You can still write posts here.</div>}
      {error && <div className="banner banner-bad">{error}</div>}

      <section className="card admin-section">
        <div className="admin-button-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="job-meta" style={{ margin: 0 }}>
            {report.posts.length} post(s) · <a href="/blog" target="_blank" rel="noreferrer">/blog</a> · week of {report.currentWeek}
          </p>
          <div className="admin-button-row">
            <button className="btn" disabled={!report.configured || !report.humanizerConfigured || report.writing || busy} onClick={() => write(Boolean(thisWeek))}>
              {report.writing ? 'Writing…' : thisWeek ? 'Rewrite this week’s' : 'Write now'}
            </button>
            <button className="btn primary" disabled={!report.configured || !report.humanizerConfigured || report.writing || busy} onClick={() => write(false, true)}>Add another blog</button>
          </div>
        </div>
        <p className="job-meta">Add another blog researches a different angle, humanizes the writing, checks the final article, and publishes a separate post on the website.</p>
        <div className="table-wrap">
          <StackedTable>
            <thead>
              <tr>
                <th>Week</th>
                <th>Post</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {report.posts.map((post) => (
                <tr key={post.id}>
                  <td>{post.week}<span className="job-meta" style={{ display: 'block' }}>{post.kind === 'extra' ? 'Extra post' : 'Weekly brief'}</span></td>
                  <td>
                    <a href={post.url} target="_blank" rel="noreferrer">{post.title}</a>
                    <span className="job-meta" style={{ display: 'block' }}>
                      Published {when(post.publishedAt)}
                      {post.updatedAt !== post.publishedAt ? ` · rewritten ${when(post.updatedAt)}` : ''}
                      {` · ${post.revisions} fact-check revision(s)`}
                      {post.humanizedAt ? ` · Humanized (${post.humanizerModel})` : ' · Awaiting humanizing'}
                      {post.unavailable.length > 0 && ` · written without: ${post.unavailable.join('; ')}`}
                    </span>
                  </td>
                  <td><span className={`badge ${post.hidden ? 'warn' : 'ok'}`}>{post.hidden ? 'Hidden' : 'Live'}</span></td>
                  <td>
                    <button className="btn" onClick={() => setHidden(post.id, !post.hidden)}>{post.hidden ? 'Show' : 'Hide'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </StackedTable>
        </div>
        {!report.posts.length && <p className="job-meta admin-empty">Nothing published yet.</p>}
      </section>
    </div>
  );
}
