import { useEffect, useState } from 'react';

export interface SetupCheck {
  id: string;
  label: string;
  done: boolean;
  hint: string;
  fix: 'documents' | 'looking' | 'where' | 'external';
  required: boolean;
}

export interface SetupStatus {
  checks: SetupCheck[];
  ready: boolean;
  done: number;
  total: number;
}

export function useSetupStatus(): SetupStatus | null {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  useEffect(() => {
    const load = () => fetch('/api/setup/status').then((r) => r.json()).then(setStatus).catch(() => {});
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, []);
  return status;
}

/**
 * Readiness, shown where the user actually starts a run.
 *
 * Without this a disappointing run is ambiguous — no matches, or no résumé
 * uploaded? Each row is the next action rather than a status label, and the
 * whole card disappears once the required steps are done so it never becomes
 * furniture.
 */
export function SetupChecklist({
  status,
  onFix,
}: {
  status: SetupStatus;
  onFix: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const outstanding = status.checks.filter((c) => !c.done);

  if (!outstanding.length) return null;

  const blocking = outstanding.filter((c) => c.required);
  const optional = outstanding.filter((c) => !c.required);

  return (
    <div className={`card checklist ${blocking.length ? 'blocking' : ''}`}>
      <div className="checklist-head">
        <div>
          <strong>
            {blocking.length
              ? `${blocking.length} thing${blocking.length > 1 ? 's' : ''} to set up before running`
              : 'Ready to run'}
          </strong>
          <div className="job-meta">
            {status.done} of {status.total} done
            {!blocking.length && optional.length ? ` · ${optional.length} optional improvement${optional.length > 1 ? 's' : ''}` : ''}
          </div>
        </div>
        {!blocking.length && (
          <button className="btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Hide' : 'Show'}
          </button>
        )}
      </div>

      {(blocking.length > 0 || expanded) && (
        <ul className="checklist-items">
          {(blocking.length ? blocking : outstanding).map((c) => (
            <li key={c.id}>
              <span className="checklist-mark">{c.required ? '!' : '○'}</span>
              <span>
                <strong>{c.label}</strong>
                <div className="job-meta">{c.hint}</div>
              </span>
              {c.fix !== 'external' && (
                <button className="btn checklist-btn" onClick={onFix}>
                  Fix
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
