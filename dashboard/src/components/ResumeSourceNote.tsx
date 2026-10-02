/**
 * Which resume applications send: always the one in Owtomate.
 *
 * One quiet line just above the button that starts a run, where the question
 * comes up. `compact` drops the Settings link for places, like the run
 * review, where leaving the page would lose what is being edited.
 */
export function ResumeSourceNote({ compact = false }: { compact?: boolean }) {
  return (
    <p className="resume-line" role="note">
      <svg className="resume-line-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M9.5 1.5V5H13M6 8h5M6 10.5h5M6 13h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <span>Applies with your resume in Owtomate</span>
      {!compact && (
        <>
          <span className="resume-line-sep" aria-hidden="true">·</span>
          <a href="/?tab=setup">Manage</a>
        </>
      )}
    </p>
  );
}
