/**
 * Which résumé applications send: always the one in Owtomate.
 *
 * Shown where a run is started, so nobody expects a CV they saved on SEEK or
 * Indeed to go out. `compact` drops the Setup link for places, like the run
 * review, where leaving the page would lose what is being edited.
 */
export function ResumeSourceNote({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`resume-source ${compact ? 'compact' : ''}`} role="note">
      <span className="resume-source-icon" aria-hidden="true">📄</span>
      <p>
        <strong>Owtomate applies with the résumé you uploaded to Owtomate.</strong>{' '}
        <span className="job-meta">Résumés saved on SEEK or Indeed are never sent.</span>
      </p>
      {!compact && <a className="btn btn-small" href="/?tab=setup">Manage résumé</a>}
    </div>
  );
}
