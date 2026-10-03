import { useCallback, useEffect, useState } from 'react';
import { api } from '../adminApi';
import { StackedTable } from './StackedTable';

/**
 * The weekly job-market brief: what has gone up, what failed, and the two
 * controls an operator needs — take a post down, or write this week's now.
 * Writing, fact-checking and publishing all happen on the server.
 */

interface BlogReport {
  enabled: boolean;
  configured: boolean;
  model: string | null;
  currentWeek: string;
  writing: boolean;
  posts: Array<{ id: string; week: string; slug: string; title: string; url: string; hidden: boolean; publishedAt: string; updatedAt: string; revisions: number; unavailable: string[] }>;
  attempts: Array<{ week: string; attempts: number; lastAttemptAt: string | null; lastError: string | null }>;
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

  function write(replace: boolean) {
    setBusy(true);
    setError(null);
    api('/blog/write', { method: 'POST', json: { replace } })
      .then(load)
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

  const thisWeek = report.posts.find((post) => post.week === report.currentWeek);
  const thisWeekAttempt = report.attempts.find((attempt) => attempt.week === report.currentWeek);

  return (
    <div className="admin-stack">
      {!report.configured ? (
        <div className="banner banner-bad">No Celeris API key. Add one under Config → Models.</div>
      ) : !report.enabled ? (
        <div className="banner">Weekly publishing is off (Config → Weekly blog). Published posts stay up.</div>
      ) : report.writing ? (
        <div className="banner">Writing this week’s brief — gathering searches and sources, drafting, fact-checking. This takes a few minutes.</div>
      ) : thisWeekAttempt?.lastError && !thisWeek ? (
        <div className="banner banner-bad">This week’s brief failed ({thisWeekAttempt.attempts} tries): {thisWeekAttempt.lastError}</div>
      ) : (
        <div className="banner banner-ok">{thisWeek ? 'This week’s brief is published.' : 'This week’s brief goes up from 6am Monday.'} Model: {report.model}.</div>
      )}
      {error && <div className="banner banner-bad">{error}</div>}

      <section className="card admin-section">
        <div className="admin-button-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="job-meta" style={{ margin: 0 }}>
            {report.posts.length} post(s) · <a href="/blog" target="_blank" rel="noreferrer">/blog</a> · week of {report.currentWeek}
          </p>
          <button className="btn primary" disabled={!report.configured || report.writing || busy} onClick={() => write(Boolean(thisWeek))}>
            {report.writing ? 'Writing…' : thisWeek ? 'Rewrite this week’s' : 'Write now'}
          </button>
        </div>
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
                  <td>{post.week}</td>
                  <td>
                    <a href={post.url} target="_blank" rel="noreferrer">{post.title}</a>
                    <span className="job-meta" style={{ display: 'block' }}>
                      Published {when(post.publishedAt)}
                      {post.updatedAt !== post.publishedAt ? ` · rewritten ${when(post.updatedAt)}` : ''}
                      {` · ${post.revisions} fact-check revision(s)`}
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
