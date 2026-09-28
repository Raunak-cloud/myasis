import { lazy, Suspense, useState } from 'react';
import type { SetupSection, SetupStatus } from '../setupStatus';

const SetupPanel = lazy(() => import('./SetupPanel').then((module) => ({ default: module.SetupPanel })));

const ACTION_LABEL: Record<SetupSection, string> = {
  documents: 'Upload your résumé',
  details: 'Complete your details',
  looking: 'Add job titles',
  where: 'Choose your location and work style',
  boards: 'Connect a job board',
};

/** One clear next action, with the full setup forms available inline. */
export function SetupChecklist({
  status,
  expanded,
  onExpandedChange,
  onVerifyingSignInChange,
}: {
  status: SetupStatus;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onVerifyingSignInChange: (verifying: boolean) => void;
}) {
  const [targetStep, setTargetStep] = useState<SetupSection | null>(null);
  const outstanding = status.checks.filter((check) => !check.done);
  if (!outstanding.length && !expanded) return null;

  const blocking = outstanding.filter((check) => check.required);
  const optional = outstanding.filter((check) => !check.required);
  const next = blocking[0];
  const progress = status.total ? (status.done / status.total) * 100 : 0;

  const openStep = (section: SetupSection) => {
    setTargetStep(section);
    onExpandedChange(true);
  };

  return (
    <div className={`card checklist ${blocking.length ? 'blocking' : ''}`}>
      <div className="checklist-head">
        <div className="checklist-summary">
          <span className="checklist-kicker">Setup</span>
          <strong className="checklist-title">
            {blocking.length ? 'Get ready for your first run' : 'Setup complete'}
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

      {next && !expanded && (
        <div className="checklist-next">
          <div className="checklist-next-copy">
            <span className="checklist-next-label">
              Step {status.checks.findIndex((check) => check.id === next.id) + 1} of {status.total}
            </span>
            <strong>{next.fix === 'external' ? next.label : ACTION_LABEL[next.fix]}</strong>
            <span className="job-meta">{next.hint}</span>
          </div>
          {next.fix !== 'external' && (
            <button type="button" className="btn primary checklist-primary" onClick={() => openStep(next.fix as SetupSection)}>
              Continue setup
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        className="checklist-disclosure"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) setTargetStep(null);
          onExpandedChange(!expanded);
        }}
      >
        {expanded ? 'Hide steps' : `Show all ${status.total} steps here`}
      </button>

      {expanded && (
        <Suspense fallback={<div className="job-meta">Loading setup…</div>}>
          <SetupPanel inline initialStep={targetStep} onVerifyingSignInChange={onVerifyingSignInChange} />
        </Suspense>
      )}
    </div>
  );
}
