import { useState } from 'react';
import type { SetupSection, SetupStatus } from '../setupStatus';

const ACTION_LABEL: Record<SetupSection, string> = {
  documents: 'Upload your résumé',
  details: 'Complete your details',
  looking: 'Add job titles',
  where: 'Choose your location and work style',
};

/** One clear next action; the complete readiness checklist remains available. */
export function SetupChecklist({
  status,
  onFix,
}: {
  status: SetupStatus;
  onFix: (section: SetupSection) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const outstanding = status.checks.filter((check) => !check.done);
  if (!outstanding.length) return null;

  const blocking = outstanding.filter((check) => check.required);
  const optional = outstanding.filter((check) => !check.required);
  const next = blocking[0];
  const progress = status.total ? (status.done / status.total) * 100 : 0;

  return (
    <div className={`card checklist ${blocking.length ? 'blocking' : ''}`}>
      <div className="checklist-head">
        <div className="checklist-summary">
          <span className="checklist-kicker">Setup</span>
          <strong className="checklist-title">
            {blocking.length ? 'Get ready for your first run' : 'You’re ready to run'}
          </strong>
          {!blocking.length && optional.length > 0 && (
            <span className="job-meta">
              {optional.length} optional improvement{optional.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <span className="checklist-count">{status.done} of {status.total} complete</span>
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

      {next && (
        <div className="checklist-next">
          <div className="checklist-next-copy">
            <span className="checklist-next-label">
              Step {status.checks.findIndex((check) => check.id === next.id) + 1} of {status.total}
            </span>
            <strong>{next.fix === 'external' ? next.label : ACTION_LABEL[next.fix]}</strong>
            <span className="job-meta">{next.hint}</span>
          </div>
          {next.fix !== 'external' && (
            <button type="button" className="btn primary checklist-primary" onClick={() => onFix(next.fix as SetupSection)}>
              Continue setup
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        className="checklist-disclosure"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'Hide all steps' : `View all ${status.total} steps`}
      </button>

      {expanded && (
        <ul className="checklist-items">
          {status.checks.map((check, index) => (
            <li key={check.id}>
              <span className={`checklist-mark${check.done ? ' done' : ''}`} aria-hidden="true">
                {check.done ? '✓' : index + 1}
              </span>
              <span className="checklist-copy">
                <strong>{check.label}</strong>
                <span className="job-meta">{check.hint}</span>
              </span>
              {check.fix !== 'external' && (
                <button type="button" className="btn checklist-btn" onClick={() => onFix(check.fix as SetupSection)}>
                  {check.done ? 'Review' : 'Open'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
