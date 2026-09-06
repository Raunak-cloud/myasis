import { useMemo, useState } from 'react';
import type { Application, Outcome } from '../types';
import { fmtDate, daysSince, scoreClass } from '../format';

interface Props {
  apps: Application[];
  onChange: (a: Application[]) => void;
  followUpDays: number;
}

const OUTCOMES: Array<{ id: Outcome; label: string; tone: string }> = [
  { id: 'interview', label: 'Interview', tone: 'ok' },
  { id: 'rejected', label: 'Rejected', tone: 'bad' },
  { id: 'closed', label: 'No longer interested', tone: 'muted' },
];

/**
 * What you sent, and what came back.
 *
 * The point of this screen is the follow-up column: an application sitting
 * unanswered for a fortnight is the single most actionable thing a job seeker
 * has, and nothing else in the product surfaces it.
 */
export function ApplicationsPanel({ apps, onChange, followUpDays }: Props) {
  const [filter, setFilter] = useState<'all' | 'awaiting' | 'interview' | 'rejected'>('all');
  const [open, setOpen] = useState<Application | null>(null);
  const [query, setQuery] = useState('');

  async function setOutcome(jobId: string, outcome: Outcome | null) {
    const res = await fetch('/api/applications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, patch: { outcome } }),
    });
    const j = await res.json();
    if (j.applications) onChange(j.applications);
    setOpen(null);
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return apps
      .filter((a) => {
        if (filter === 'awaiting') return !a.outcome && daysSince(a.appliedAt) >= followUpDays;
        if (filter === 'interview') return a.outcome === 'interview';
        if (filter === 'rejected') return a.outcome === 'rejected';
        return true;
      })
      .filter(
        (a) =>
          !q ||
          a.title.toLowerCase().includes(q) ||
          a.company.toLowerCase().includes(q) ||
          (a.coverLetter ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt));
  }, [apps, filter, query, followUpDays]);

  const counts = useMemo(
    () => ({
      all: apps.length,
      awaiting: apps.filter((a) => !a.outcome && daysSince(a.appliedAt) >= followUpDays).length,
      interview: apps.filter((a) => a.outcome === 'interview').length,
      rejected: apps.filter((a) => a.outcome === 'rejected').length,
    }),
    [apps, followUpDays],
  );

  return (
    <div>
      <div className="queue-bar">
        <div className="chips">
          {(['all', 'awaiting', 'interview', 'rejected'] as const).map((f) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'awaiting' ? 'Needs follow-up' : f[0].toUpperCase() + f.slice(1)}
              <span className="chip-hint">{counts[f]}</span>
            </button>
          ))}
        </div>
        <input
          className="input"
          placeholder="Search role, company, letter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <div className="card empty">
          <div className="big">{apps.length ? 'Nothing here' : 'No applications yet'}</div>
          <p>{apps.length ? 'Try another filter.' : 'Applications appear here once you submit them.'}</p>
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Applied</th>
                <th>Status</th>
                <th>Score</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const age = daysSince(a.appliedAt);
                const stale = !a.outcome && age >= followUpDays;
                return (
                  <tr key={a.jobId} className="clickable" onClick={() => setOpen(a)}>
                    <td>
                      <div className="job-title">{a.title}</div>
                      <div className="job-meta">
                        {a.company} · {a.location}
                      </div>
                    </td>
                    <td className="nowrap">
                      <div>{fmtDate(a.appliedAt)}</div>
                      <div className="job-meta">{age === 0 ? 'today' : `${age}d ago`}</div>
                    </td>
                    <td>
                      {a.outcome ? (
                        <span className={`badge ${OUTCOMES.find((o) => o.id === a.outcome)?.tone ?? 'muted'}`}>
                          {OUTCOMES.find((o) => o.id === a.outcome)?.label}
                        </span>
                      ) : stale ? (
                        <span className="badge warn">follow up</span>
                      ) : (
                        <span className="badge muted">sent</span>
                      )}
                    </td>
                    <td>
                      <span className={`score ${scoreClass(a.score)}`}>{a.score || '—'}</span>
                    </td>
                    <td className="nowrap">
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        SEEK ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="overlay" onClick={() => setOpen(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div className="minw">
                <h2>{open.title}</h2>
                <div className="job-meta">
                  {open.company} · applied {fmtDate(open.appliedAt)} ({daysSince(open.appliedAt)}d ago)
                </div>
              </div>
              <button className="btn" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>

            <div className="drawer-body">
              <div className="section">
                <h3>Outcome</h3>
                <div className="chips">
                  {OUTCOMES.map((o) => (
                    <button
                      key={o.id}
                      className={`chip ${open.outcome === o.id ? 'on' : ''}`}
                      onClick={() => setOutcome(open.jobId, o.id)}
                    >
                      {o.label}
                    </button>
                  ))}
                  {open.outcome && (
                    <button className="chip" onClick={() => setOutcome(open.jobId, null)}>
                      Clear
                    </button>
                  )}
                </div>
                {!open.outcome && daysSince(open.appliedAt) >= followUpDays && (
                  <p className="job-meta follow-hint">
                    Sent {daysSince(open.appliedAt)} days ago with no outcome recorded — a short
                    follow-up to the recruiter is reasonable at this point.
                  </p>
                )}
              </div>

              {open.coverLetter && (
                <div className="section">
                  <h3>Cover letter sent</h3>
                  <div className="letter">{open.coverLetter}</div>
                </div>
              )}

              {open.answers?.length ? (
                <div className="section">
                  <h3>Screening answers</h3>
                  {open.answers
                    .filter((a) => !/^write a cover letter$/i.test(a.question.trim()))
                    .map((a, i) => (
                      <div className="qa" key={i}>
                        <div className="q">{a.question}</div>
                        <div className="a">{a.answer}</div>
                      </div>
                    ))}
                </div>
              ) : null}

              <div className="section">
                <h3>Listing</h3>
                <a href={open.url} target="_blank" rel="noreferrer">
                  Open on SEEK ↗
                </a>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
