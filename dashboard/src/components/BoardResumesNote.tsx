import { useEffect, useState } from 'react';

/**
 * Resumes saved on SEEK or Indeed that Owtomate does not hold.
 *
 * Applications always send the resume in Owtomate, never one of these, so a
 * person who uploads a new CV straight to SEEK would otherwise wonder why
 * employers are not getting it. Said once, with the way to use one; hidden
 * for good once dismissed, until the list changes.
 */
interface BoardResumes { boards: Array<{ board: 'seek' | 'indeed'; names: string[]; replaced?: Array<{ name: string; uploadedAs: string }> }> }

const BOARD = { seek: 'SEEK', indeed: 'Indeed' } as const;

export function BoardResumesNote() {
  const [boards, setBoards] = useState<BoardResumes['boards']>([]);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try { return localStorage.getItem('board-resumes-dismissed'); } catch { return null; }
  });

  useEffect(() => {
    fetch('/api/board-resumes')
      .then((response) => (response.ok ? response.json() as Promise<BoardResumes> : { boards: [] }))
      .then((body) => setBoards(body.boards ?? []))
      .catch(() => {});
  }, []);

  const signature = boards.map((entry) => `${entry.board}:${entry.names.join('|')}:${(entry.replaced ?? []).map((r) => r.uploadedAs).join('|')}`).join(';');
  if (!boards.length || dismissed === signature) return null;

  const dismiss = () => {
    try { localStorage.setItem('board-resumes-dismissed', signature); } catch { /* the note simply returns next visit */ }
    setDismissed(signature);
  };

  return (
    <div className="banner board-resumes-note" role="note">
      <div>
        {boards.map((entry) => {
          // The copy Owtomate sends now is the one it saved last.
          const sending = entry.replaced?.at(-1)?.uploadedAs;
          return (
            <p key={entry.board}>
              {sending
                ? <>On <strong>{BOARD[entry.board]}</strong>, Owtomate sends <strong>{sending}</strong>, its exact copy of your resume.</>
                : <>On <strong>{BOARD[entry.board]}</strong>, Owtomate sends your resume from Owtomate.</>}
              {' '}Other resumes saved there aren't used.
            </p>
          );
        })}
        <p className="job-meta">To send a different resume, upload it in Setup.</p>
      </div>
      <div className="board-resumes-actions">
        <a className="btn btn-small" href="/?tab=setup">Upload in Setup</a>
        <button type="button" className="link-button" onClick={dismiss}>Dismiss</button>
      </div>
    </div>
  );
}
