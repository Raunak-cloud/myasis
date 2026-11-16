interface Props {
  week: number | null;
  submitted: number | null;
  reviewed: number | null;
  needsAttention: number;
  needsVerification: boolean;
  onViewApplications: () => void;
  onViewAttention: () => void;
}

export function ApplicationOverview({ week, submitted, reviewed, needsAttention, needsVerification, onViewApplications, onViewAttention }: Props) {
  return <section className="apply-overview card" aria-label="Application summary">
    <div className="apply-overview-head">
      <h2>Overview</h2>
      {needsAttention > 0 && <button type="button" className="apply-attention" onClick={onViewAttention}>
        {needsAttention} {needsVerification ? 'need verification' : 'need attention'} <span aria-hidden="true">↗</span>
      </button>}
    </div>
    <div className="apply-overview-stats">
      <button type="button" className="apply-stat" onClick={onViewApplications}>
        <strong>{week ?? '?'}</strong>
        <span>Applied this week <span aria-hidden="true">↗</span></span>
      </button>
      <div className="apply-stat"><strong>{submitted ?? '?'}</strong><span>Sent today</span></div>
      <div className="apply-stat"><strong>{reviewed ?? '?'}</strong><span>Reviewed today</span></div>
    </div>
  </section>;
}
