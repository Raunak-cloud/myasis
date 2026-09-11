import { useEffect, useMemo, useState } from 'react';
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
 *
 * Rendered in its own full-width row rather than inside the Detail cell.
 * That cell is 34% of the table, so a capture of a 1280-wide browser landed
 * at roughly a third of its real size — present, but far too small to read
 * the form that actually blocked the application.
 */
function TraceSteps({ jobId }: { jobId: string }) {
  const [steps, setSteps] = useState<TraceStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A capture opened over the page, for when full-row width still is not enough. */
  const [enlarged, setEnlarged] = useState<TraceStep | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/trace?jobId=${encodeURIComponent(jobId)}`);
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(body.error ?? 'No trace available.');
        setSteps(body.steps ?? []);
      } catch (reason) {
        if (!cancelled) setError((reason as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return (
    <div className="trace">
      {error && <div className="job-meta">{error}</div>}
      {!steps && !error && <div className="job-meta">Loading steps…</div>}
      {steps?.map((s) => (
        <div key={s.step} className="trace-step">
          <div className="job-meta">
            <strong>Step {s.step}</strong> · {s.label}
            {s.result ? <span className="trace-result"> → {s.result}</span> : null}
          </div>
          {s.screenshot ? (
            <button className="trace-shot-button" onClick={() => setEnlarged(s)}>
              <img className="trace-shot" src={s.screenshot} alt={`Step ${s.step}`} loading="lazy" />
              <span className="trace-shot-hint">Click to enlarge</span>
            </button>
          ) : null}
        </div>
      ))}

      {enlarged && (
        <div className="overlay center" onClick={() => setEnlarged(null)} role="dialog" aria-modal="true">
          <div className="card trace-zoom" onClick={(event) => event.stopPropagation()}>
            <div className="trace-zoom-bar">
              <span className="job-meta">
                <strong>Step {enlarged.step}</strong> · {enlarged.label}
              </span>
              <button className="btn btn-small" onClick={() => setEnlarged(null)}>
                Close
              </button>
            </div>
            <img src={enlarged.screenshot} alt={`Step ${enlarged.step}`} />
          </div>
        </div>
      )}
    </div>
  );
}

/** One blocked job, plus its step-by-step trace on a full-width row beneath. */
function AttentionRow({ item, onCleared }: { item: AttentionItem; onCleared?: () => void }) {
  const [showTrace, setShowTrace] = useState(false);
  return (
    <>
      <tr>
        <td>
          <div className="job-title">{item.title}</div>
          <div className="job-meta">{item.company}</div>
        </td>
        <td>
          <span className={`badge ${KIND[item.kind].tone}`}>{KIND[item.kind].label}</span>
        </td>
        <td className="job-meta attention-reason">
          {item.reason}
          {item.questions?.length ? <AnswerForm item={item} onSaved={onCleared} /> : null}
          <div className="trace-actions">
            <button className="btn btn-small" onClick={() => setShowTrace((open) => !open)}>
              {showTrace ? 'Hide steps' : 'View steps'}
            </button>
          </div>
        </td>
        <td className="nowrap job-meta">{relative(item.at)}</td>
        <td className="nowrap">
          <a href={item.url} target="_blank" rel="noreferrer">
            Open ↗
          </a>
        </td>
      </tr>
      {showTrace && (
        <tr className="trace-row">
          <td colSpan={5}>
            <TraceSteps jobId={item.jobId} />
          </td>
        </tr>
      )}
    </>
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
              <AttentionRow key={i.jobId} item={i} onCleared={onCleared} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
