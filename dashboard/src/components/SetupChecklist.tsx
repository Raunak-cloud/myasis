import { useState } from 'react';
import type { SetupStatus } from '../setupStatus';


/** Readiness and direct next steps, shown beside the run controls. */
export function SetupChecklist({
  status,
  onFix,
}: {
  status: SetupStatus;
  onFix: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const outstanding = status.checks.filter((check) => !check.done);

  if (!outstanding.length) return null;

  const blocking = outstanding.filter((check) => check.required);
  const optional = outstanding.filter((check) => !check.required);
  const visible = blocking.length ? blocking : outstanding;
  const progress = status.total ? (status.done / status.total) * 100 : 0;

  return (
    <div className={`card checklist ${blocking.length ? 'blocking' : ''}`}>
      <div className="checklist-head">
        <div className="checklist-summary">
          <span className="checklist-kicker">Setup</span>
          <strong className="checklist-title">
            {blocking.length
              ? `${blocking.length} step${blocking.length > 1 ? 's' : ''} left before your first run`
              : 'Ready to run'}
          </strong>
          {!blocking.length && optional.length > 0 && (
            <span className="job-meta">
              {optional.length} optional improvement{optional.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="checklist-head-actions">
          <span className="checklist-count">
            {status.done} completed · {status.total - status.done} remaining
          </span>
          {!blocking.length && (
            <button className="btn" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
      </div>

      <div
        className="checklist-progress"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={status.total}
        aria-valuenow={status.done}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      {(blocking.length > 0 || expanded) && (
        <ul className="checklist-items">
          {visible.map((check, index) => (
            <li key={check.id}>
              <span className="checklist-mark" aria-hidden="true">{index + 1}</span>
              <span className="checklist-copy">
                <strong>{check.label}</strong>
                <span className="job-meta">{check.hint}</span>
              </span>
              {check.fix !== 'external' && (
                <button className="btn checklist-btn" onClick={onFix}>
                  Set up
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
