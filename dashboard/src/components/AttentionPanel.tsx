import { useEffect, useMemo, useState } from 'react';
import { relative } from '../format';
import { userFacingError } from '../run-messages';
import { attentionCopy } from '../attention-copy';
import { blockedQuestionKey } from '../../../seek-bot/src/blocked-question-key';

export type AttentionKind = 'captcha' | 'verification' | 'question' | 'off-platform' | 'error' | 'account-access';

import type { CapturedQuestion as BlockedQuestion } from '../../../seek-bot/src/question-snapshot';
import type { QuestionResponse } from '../../../seek-bot/src/question-snapshot';
import { EmployerQuestion } from './EmployerQuestion';
import { questionResponseIssue } from '../../../seek-bot/src/question-snapshot';

export interface AttentionItem {
  jobId: string;
  title: string;
  company: string;
  kind: AttentionKind;
  reason: string;
  url: string;
  at: string;
  /** Questions the candidate can answer right here to unblock the job. */
  questions?: BlockedQuestion[];
  needsQuestionCapture?: boolean;
  accountAccess?: import('../../../seek-bot/src/employer-account').AccountAccess;
}

/** The question as the candidate should read it: the written-out one when there is one, else the form's own label. */
const questionText = (q: BlockedQuestion) => q.snapshot?.prompt || q.prompt || q.question;
const questionKey = blockedQuestionKey;

/**
 * Inline form for the questions a run could not answer. Saving writes them to
 * the answer bank, which every later run reads. Unanswered questions stay
 * visible until the rest of the group is answered.
 */
export function AnswerForm({ item, onSaved }: { item: AttentionItem; onSaved?: () => void }) {
  const questions = item.questions ?? [];
  const [values, setValues] = useState<Record<string, QuestionResponse>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answered=questions.filter(q=>q.snapshot&&values[questionKey(q)]&&questionResponseIssue(q.snapshot,values[questionKey(q)])===null);
  async function save() {
    if(saving||!answered.length)return;
    setSaving(true);setError(null);
    const submitted=answered.map(q=>({questionId:q.snapshot!.id,revision:q.snapshot!.revision,response:values[questionKey(q)]}));
    try {
      const response=await fetch('/api/answers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:item.jobId,answers:submitted})});
      const body=await response.json().catch(()=>null);
      if(!response.ok||body?.saved!==submitted.length)throw new Error(body?.error??'Could not save the answers. Please try again.');
      setValues(current=>{
        const next={...current};
        for(const q of answered){const key=questionKey(q);if(JSON.stringify(current[key])===JSON.stringify(values[key]))delete next[key];}
        return next;
      });
      onSaved?.();
    }catch{setError(attentionCopy.saveError);}finally{setSaving(false);}
  }
  return <form className="answer-form" noValidate onSubmit={e=>{e.preventDefault();void save();}}>
    {questions.map(q=>q.snapshot?<EmployerQuestion key={questionKey(q)} snapshot={q.snapshot} value={values[questionKey(q)]??{}} onChange={v=>setValues(current=>({...current,[questionKey(q)]:v}))}/>:<div key={questionKey(q)} className="answer-row"><small>{attentionCopy.recapture}</small></div>)}
    {error&&<div role="alert" className="banner banner-bad">{userFacingError(error)}</div>}
    <div className="answer-actions"><button className="btn primary" disabled={saving||!answered.length} type="submit">{saving?'Saving…':'Save answers'}</button></div>
  </form>;
}

interface TraceStep {
  step: number;
  url: string;
  label: string;
  result?: string;
  screenshot?: string;
  disposition?: string;
  startedAt?: string;
  completedAt?: string;
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
export function TraceSteps({ jobId, questions = [], endpoint }: { jobId: string; questions?: BlockedQuestion[]; endpoint?: string }) {
  return <TraceContent key={JSON.stringify([jobId, endpoint])} jobId={jobId} questions={questions} endpoint={endpoint} />;
}

function TraceContent({ jobId, questions, endpoint }: { jobId: string; questions: BlockedQuestion[]; endpoint?: string }) {
  const [steps, setSteps] = useState<TraceStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A capture opened over the page, for when full-row width still is not enough. */
  const [enlarged, setEnlarged] = useState<TraceStep | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(endpoint ?? `/api/trace?jobId=${encodeURIComponent(jobId)}`);
        const body = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok || !Array.isArray(body?.steps)) throw new Error(body?.error ?? 'No trace available.');
        setSteps(body.steps);
      } catch (reason) {
        if (!cancelled) setError((reason as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, endpoint]);

  return (
    <div className="trace">
      {questions.length > 0 && (
        <div className="trace-question-context">
          <strong>What the employer needs from you</strong>
          {questions.map((question) => <div key={questionKey(question)}>{questionText(question)}</div>)}
        </div>
      )}
      {error && <div className="job-meta">{userFacingError(error)}</div>}
      {!steps && !error && <div className="job-meta">Loading steps…</div>}
      {steps && steps.length > 0 && !steps.some(step => step.screenshot) && (
        <div className="trace-text-only job-meta">Screenshots weren’t saved for this application. Its recorded steps are shown below.</div>
      )}
      {steps?.map((s, index) => (
        <div key={`${s.step}-${index}`} className={`trace-step${s.screenshot ? '' : ' trace-step-text'}`}>
          {s.screenshot ? (
            <button className="trace-shot-button" onClick={() => setEnlarged(s)} title="Open full size">
              <img className="trace-shot" src={s.screenshot} alt={`Step ${s.step}`} loading="lazy" />
            </button>
          ) : null}
          <div className="trace-caption job-meta">
            <strong>{s.step}.</strong> {s.label}
            {s.disposition === 'failed' && <span className="badge bad">Tool error</span>}
            {s.disposition === 'reobserve' && <span className="badge warn">Reinspection needed</span>}
            {s.startedAt && !s.completedAt && <span className="badge warn">No completion recorded</span>}
            {s.result && <details><summary>Full tool result</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{s.result}</pre></details>}
            {s.result ? <span className="trace-result"> → {s.result}</span> : null}
          </div>
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
  const captured=item.questions?.filter(question=>question.snapshot)??[];
  const needsCapture=item.needsQuestionCapture||captured.length!==(item.questions?.length??0)||!captured.length;
  return (
    <>
      <tr className="attention-item">
        <td className="attention-role">
          <div className="job-title">{item.title}</div>
          <div className="job-meta">{item.company}</div>
        </td>
        <td className="attention-blocker">
          <span className={`badge ${KIND[item.kind].tone}`}>{KIND[item.kind].label}</span>
        </td>
        <td className="job-meta attention-reason">
          {/* With a question to answer, the question is the whole story; the reason only repeated it. */}
          {item.kind==='account-access'?<p>{item.reason}</p>:<>
            {captured.length>0&&<AnswerForm item={{...item,questions:captured}} onSaved={onCleared} />}
            {needsCapture&&<p>{attentionCopy.recapture}</p>}
          </>}
        </td>
        <td className="attention-when nowrap job-meta">{relative(item.at)}</td>
        <td className="attention-open nowrap">
          <a href={item.url} target="_blank" rel="noreferrer">
            Open ↗
          </a>
        </td>
      </tr>
    </>
  );
}

const KIND: Record<AttentionKind, { label: string; tone: string; what: string }> = {
  'account-access': {label:'Sign-in needed',tone:'warn',what:'Sign in to your existing employer account in your Owtomate browser.'},
  verification: {
    label: 'Work rights',
    tone: 'warn',
    what: 'SEEK wants your work rights verified before this listing will accept an application. Completing SEEK Pass once unlocks all of them.',
  },
  captcha: {
    label: 'Security check',
    tone: 'warn',
    what: 'A bot check appeared. Open the listing and clear it yourself, then re-run.',
  },
  question: {
    label: 'Needs an answer',
    tone: 'info',
    what: 'A screening question could not be answered from your profile or documents. Answer it below once and every future run will reuse your answer.',
  },
  'off-platform': {
    label: 'External site · Beta',
    tone: 'muted',
    what: "The application continues on the employer's website. Check its current status there.",
  },
  error: {
    label: 'Error',
    tone: 'bad',
    what: 'The application could not be completed. Check its status on the job site before trying again.',
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
  loading = false,
  loadError = null,
}: {
  items: AttentionItem[];
  onCleared?: () => void;
  loading?: boolean;
  loadError?: string | null;
  isAdmin?: boolean;
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
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok !== true) throw new Error(body?.error ?? 'Could not clear the list. Please try again.');
      onCleared?.();
    } catch {
      setError(attentionCopy.clearError);
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

  if (loadError && !items.length) return <div className="card empty" role="alert"><p>{attentionCopy.loadError}</p><button className="btn" onClick={onCleared}>Try again</button></div>;
  if (loading && !items.length) return <div className="card empty" role="status">Checking for jobs that need your attention…</div>;
  if (!items.length) {
    return (
      <div className="card empty">
        <div className="big">No questions waiting</div>
        <p>Application questions that need your answer will appear here.</p>
      </div>
    );
  }

  return (
    <div className="attention-panel">
      {loadError && <div className="banner banner-bad" role="alert">{attentionCopy.loadError} <button type="button" className="btn" onClick={onCleared}>Try again</button></div>}
      {counts.verification ? (
        <div className="banner attention-hero">
          <strong>{counts.verification} listings are waiting on work-rights verification.</strong>
          <br />
          Completing SEEK Pass once on your account unlocks all of them. It is the single highest-value
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

      {error && <div className="banner banner-bad">{userFacingError(error)}</div>}

      {kind !== 'all' && <p className="job-meta attention-what">{KIND[kind].what}</p>}

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
