import { useMemo, useState } from 'react';
import { relative } from '../format';

export type AttentionKind = 'captcha' | 'verification' | 'question' | 'off-platform' | 'error';

export interface AttentionItem {
  jobId: string;
  title: string;
  company: string;
  kind: AttentionKind;
  reason: string;
  url: string;
  at: string;
  /** Questions the candidate can answer right here to unblock the job. */
  questions?: string[];
}

/**
 * Inline form for the questions a run could not answer. Saving writes them to
 * the answer bank, which every later run reads, and takes the job off this
 * list so the next run retries it.
 */
function AnswerForm({ item, onSaved }: { item: AttentionItem; onSaved?: () => void }) {
  const questions = item.questions ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answered = questions.filter((q) => (values[q] ?? '').trim());

  async function save() {
    if (saving || !answered.length) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: item.jobId, answers: answered.map((q) => ({ question: q, answer: values[q].trim() })) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not save the answers.');
      onSaved?.();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="answer-form">
      {questions.map((q) => (
        <label key={q} className="field">
          <span className="job-meta">{q}</span>
          <textarea
            className="input"
            rows={2}
            value={values[q] ?? ''}
            placeholder="Your answer — it will be reused whenever a form asks this again"
            onChange={(e) => setValues({ ...values, [q]: e.target.value })}
          />
        </label>
      ))}
      {error && <div className="banner banner-bad">{error}</div>}
      <button className="btn primary" disabled={saving || !answered.length} onClick={save}>
        {saving ? 'Saving…' : `Save ${answered.length || ''} answer${answered.length === 1 ? '' : 's'} and retry next run`}
      </button>
    </div>
  );
}

interface TraceStep {
  step: number;
  url: string;
  label: string;
  result?: string;
  screenshot?: string;
}

/**
 * What the agent saw and did, step by step, for an application it could not
 * finish. Replaces guessing from a one-line reason with looking at the page.
 */
function TraceViewer({ jobId }: { jobId: string }) {
  const [steps, setSteps] = useState<TraceStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    setOpen(true);
    if (steps) return;
    try {
      const response = await fetch(`/api/trace?jobId=${encodeURIComponent(jobId)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'No trace available.');
      setSteps(body.steps ?? []);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  if (!open) {
    return (
      <button className="btn btn-small" onClick={load}>
        View steps
      </button>
    );
  }
  return (
    <div className="trace">
      <button className="btn btn-small" onClick={() => setOpen(false)}>
        Hide steps
      </button>
      {error && <div className="job-meta">{error}</div>}
      {steps?.map((s) => (
        <div key={s.step} className="trace-step">
          <div className="job-meta">
            <strong>Step {s.step}</strong> · {s.label}
            {s.result ? <span className="trace-result"> → {s.result}</span> : null}
          </div>
          {s.screenshot ? <img className="trace-shot" src={s.screenshot} alt={`Step ${s.step}`} loading="lazy" /> : null}
        </div>
      ))}
    </div>
  );
}

const KIND: Record<AttentionKind, { label: string; tone: string; what: string }> = {
  verification: {
    label: 'Work rights',
    tone: 'warn',
    what: 'SEEK wants your work rights verified before this listing will accept an application. Completing SEEK Pass once unlocks all of them.',
  },
  captcha: {
    label: 'CAPTCHA',
    tone: 'warn',
    what: 'A bot check appeared. Open the listing and clear it yourself, then re-run.',
  },
  question: {
    label: 'Needs an answer',
    tone: 'info',
    what: 'A screening question could not be answered from your profile or documents. Answer it below once and every future run will reuse your answer.',
  },
  'off-platform': {
    label: 'External site',
    tone: 'muted',
    what: 'External applications require an Intensive Pass. Supported employer forms are completed automatically; unfamiliar forms stop here for your review.',
  },
  error: {
    label: 'Error',
    tone: 'bad',
    what: 'Something failed mid-run. Nothing was submitted.',
  },
};

/**
 * What the automation could not finish.
 *
 * This is the actionable half of an unattended tool's output — the jobs that
 * stalled and why. Grouping by cause matters because the causes have very
 * different fixes: one SEEK Pass verification can clear an entire category at
 * once, while an unanswerable question is fixed by adding a document.
 */
export function AttentionPanel({
  items,
  onCleared,
}: {
  items: AttentionItem[];
  onCleared?: () => void;
}) {
  const [kind, setKind] = useState<AttentionKind | 'all'>('all');
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clearAll() {
    if (clearing) return;
    if (!confirm(`Clear all ${items.length} items? They stay in your run history, and anything still blocked will reappear the next time a run hits it.`)) return;
    setClearing(true);
    setError(null);
    try {
      const response = await fetch('/api/attention/clear', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not clear the list.');
      onCleared?.();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setClearing(false);
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const i of items) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [items]);

  const shown = useMemo(
    () => (kind === 'all' ? items : items.filter((i) => i.kind === kind)),
    [items, kind],
  );

  const kinds = useMemo(
    () => (Object.keys(KIND) as AttentionKind[]).filter((k) => counts[k]),
    [counts],
  );

  if (!items.length) {
    return (
      <div className="card empty">
        <div className="big">Nothing needs you</div>
        <p>Jobs the automation couldn't finish will appear here, grouped by what's blocking them.</p>
      </div>
    );
  }

  return (
    <div>
      {counts.verification ? (
        <div className="banner attention-hero">
          <strong>{counts.verification} listings are waiting on work-rights verification.</strong>
          <br />
          Completing SEEK Pass once on your account unlocks all of them — it's the single highest-value
          thing you can do here.
        </div>
      ) : null}

      <div className="queue-bar">
        <div className="chips">
          <button className={`chip ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}>
            All<span className="chip-hint">{counts.all}</span>
          </button>
          {kinds.map((k) => (
            <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
              {KIND[k].label}
              <span className="chip-hint">{counts[k]}</span>
            </button>
          ))}
        </div>
        <button className="btn" disabled={clearing} onClick={clearAll}>
          {clearing ? 'Clearing…' : 'Clear all'}
        </button>
      </div>

      {error && <div className="banner banner-bad">{error}</div>}

      {kind !== 'all' && <p className="job-meta attention-what">{KIND[kind].what}</p>}

      <div className="card table-wrap">
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
              <th>Blocked by</th>
              <th>Detail</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.jobId}>
                <td>
                  <div className="job-title">{i.title}</div>
                  <div className="job-meta">{i.company}</div>
                </td>
                <td>
                  <span className={`badge ${KIND[i.kind].tone}`}>{KIND[i.kind].label}</span>
                </td>
                <td className="job-meta attention-reason">
                  {i.reason}
                  {i.questions?.length ? <AnswerForm item={i} onSaved={onCleared} /> : null}
                  <div className="trace-actions">
                    <TraceViewer jobId={i.jobId} />
                  </div>
                </td>
                <td className="nowrap job-meta">{relative(i.at)}</td>
                <td className="nowrap">
                  <a href={i.url} target="_blank" rel="noreferrer">
                    Open ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
