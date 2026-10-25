import { plainReason, userFacingError } from '../run-messages';
import { useMemo, useState } from 'react';
import { relative } from '../format';

type SkipKind = 'rules' | 'fit' | 'uncertain' | 'score';
type Verdict = 'apply' | 'skip';

export interface SkippedJob {
  jobId: string;
  title: string;
  company: string;
  kind: SkipKind;
  reason: string;
  url: string;
  at: string;
  verdict: Verdict | null;
  note: string | null;
}

const KIND: Record<SkipKind, { label: string; tone: string; what: string }> = {
  fit: {
    label: 'Not a fit',
    tone: 'muted',
    what: 'The check read the listing and decided it did not suit you.',
  },
  uncertain: {
    label: 'Unsure',
    tone: 'info',
    what: 'The check could not tell from the listing whether it suited you, so it left it.',
  },
  score: {
    label: 'Low match',
    tone: 'muted',
    what: 'It suited you, but its match score was under the minimum set on the Apply page.',
  },
  rules: {
    label: 'Your instructions',
    tone: 'warn',
    what: 'Your own instructions ruled these out. If one should not have been, the instructions on the Apply page may say more than you meant.',
  },
};

type Filter = SkipKind | 'all' | 'called';

const RETENTION_NOTICE = 'Your latest 500 skipped jobs are shown here. Older decisions are remembered so unchanged jobs do not use more reviews.';

/** One skipped job: why, and the candidate's call on it. */
function SkippedRow({ job, onChange }: { job: SkippedJob; onChange: (items: SkippedJob[]) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState(job.note ?? '');
  const [editingNote, setEditingNote] = useState(false);

  async function call(verdict: Verdict | null, withNote?: string) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/skipped', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.jobId, verdict, ...(withNote !== undefined ? { note: withNote } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not save that.');
      onChange(body.items ?? []);
      setEditingNote(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="attention-item">
      <td className="attention-role">
        <div className="job-title">{job.title}</div>
        <div className="job-meta">{job.company}</div>
      </td>
      <td className="attention-blocker">
        <span className={`badge ${KIND[job.kind].tone}`}>{KIND[job.kind].label}</span>
      </td>
      <td className="job-meta attention-reason">
        {plainReason(job.reason)}
        <div className="skipped-call">
          {job.verdict === 'apply' && (
            <span className="badge ok" title="It goes back into your next run; the fit check is not asked again.">You'd apply · in the next run</span>
          )}
          {job.verdict === 'skip' && <span className="badge muted">Right call</span>}
          {!job.verdict ? (
            <>
              <button type="button" className="btn btn-small" disabled={saving} onClick={() => call('apply')}
                title="Puts this job back into your next run, and shows the fit check how you read requirements like this one.">
                I'd have applied
              </button>
              <button type="button" className="btn btn-small" disabled={saving} onClick={() => call('skip')}
                title="Tells the fit check its reading was right.">
                Right call
              </button>
            </>
          ) : (
            <>
              {!editingNote && (
                <button type="button" className="link-button" onClick={() => setEditingNote(true)}>
                  {job.note ? 'Edit your reason' : 'Add your reason'}
                </button>
              )}
              <button type="button" className="link-button" disabled={saving} onClick={() => call(null)}>Undo</button>
            </>
          )}
        </div>
        {job.note && !editingNote && <div className="skipped-note">“{job.note}”</div>}
        {editingNote && job.verdict && (
          <div className="skipped-note-edit">
            <input
              className="input"
              value={note}
              maxLength={500}
              placeholder={job.verdict === 'apply' ? 'e.g. 4 years is close enough to 5' : 'e.g. right, I do not want agency roles'}
              onChange={(event) => setNote(event.target.value)}
            />
            <button type="button" className="btn btn-small primary" disabled={saving} onClick={() => call(job.verdict, note)}>Save</button>
            <button type="button" className="link-button" onClick={() => { setNote(job.note ?? ''); setEditingNote(false); }}>Cancel</button>
          </div>
        )}
        {error && <div className="banner banner-bad">{userFacingError(error)}</div>}
      </td>
      <td className="attention-when nowrap job-meta">{relative(job.at)}</td>
      <td className="attention-open nowrap">
        {job.url ? <a href={job.url} target="_blank" rel="noreferrer">Open ↗</a> : null}
      </td>
    </tr>
  );
}

/**
 * Jobs the fit check passed over, why, and the candidate's call on each.
 *
 * The check skips most of what it reads and none of it was ever shown, so a
 * reading too strict for this candidate could not be noticed, let alone
 * corrected. "I'd have applied" puts the job back into the next run and shows
 * the check how this candidate weighs that kind of requirement; "Right call"
 * confirms a reading. Administrators only while it is tried out.
 */
export function SkippedPanel({ items, error, onItems }: {
  items: SkippedJob[] | null;
  error: string | null;
  onItems: (items: SkippedJob[]) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items?.length ?? 0, called: 0 };
    for (const item of items ?? []) {
      c[item.kind] = (c[item.kind] ?? 0) + 1;
      if (item.verdict) c.called += 1;
    }
    return c;
  }, [items]);

  const shown = useMemo(() => (items ?? []).filter((item) =>
    filter === 'all' ? true : filter === 'called' ? Boolean(item.verdict) : item.kind === filter), [items, filter]);

  if (error) return <div className="banner banner-bad">{userFacingError(error)}</div>;
  if (!items) return <div className="card empty"><p>Loading skipped jobs…</p></div>;
  if (!items.length) {
    return (
      <div className="card empty">
        <div className="big">Nothing skipped lately</div>
        <p>Jobs the fit check passes over in your runs appear here for two weeks, with the reason it gave.</p>
        <p className="job-meta">{RETENTION_NOTICE}</p>
      </div>
    );
  }

  const kinds = (Object.keys(KIND) as SkipKind[]).filter((kind) => counts[kind]);
  return (
    <div className="attention-panel">
      <div className="queue-bar">
        <div className="chips">
          <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
            All<span className="chip-hint">{counts.all}</span>
          </button>
          {kinds.map((kind) => (
            <button key={kind} className={`chip ${filter === kind ? 'on' : ''}`} onClick={() => setFilter(kind)}>
              {KIND[kind].label}<span className="chip-hint">{counts[kind]}</span>
            </button>
          ))}
          {counts.called > 0 && (
            <button className={`chip ${filter === 'called' ? 'on' : ''}`} onClick={() => setFilter('called')}>
              Your calls<span className="chip-hint">{counts.called}</span>
            </button>
          )}
        </div>
      </div>
      <p className="job-meta attention-what">
        {filter !== 'all' && filter !== 'called'
          ? KIND[filter].what
          : 'Jobs the fit check passed over in the last two weeks. If it got one wrong, choose “I’d have applied” and it goes into your next run.'}
      </p>
      <p className="job-meta attention-what">{RETENTION_NOTICE}</p>
      <div className="card table-wrap attention-list">
        <table className="attention-table">
          <colgroup>
            <col className="attention-col-role" />
            <col className="attention-col-blocker" />
            <col className="attention-col-detail" />
            <col className="attention-col-when" />
            <col className="attention-col-action" />
          </colgroup>
          <thead>
            <tr>
              <th>Role</th>
              <th>Skipped as</th>
              <th>Why</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((job) => <SkippedRow key={job.jobId} job={job} onChange={onItems} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
