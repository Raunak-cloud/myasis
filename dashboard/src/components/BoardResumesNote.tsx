import { useEffect, useState } from 'react';

/**
 * Resumes saved on SEEK or Indeed that Owtomate does not hold.
 *
 * Applications always send the resume in Owtomate, never one of these, so a
 * person who uploads a new CV straight to SEEK would otherwise wonder why
 * employers are not getting it. Said once, with the way to use one; once
 * dismissed it is gone for good, for the account on every device.
 */
interface BoardResumes { boards: Array<{ board: 'seek' | 'indeed'; names: string[]; replaced?: Array<{ name: string; uploadedAs: string }> }> }

const BOARD = { seek: 'SEEK', indeed: 'Indeed' } as const;

export function BoardResumesNote() {
  const [boards, setBoards] = useState<BoardResumes['boards']>([]);
  useEffect(() => {
    // The server answers with nothing once the account has dismissed the note.
    fetch('/api/board-resumes')
      .then((response) => (response.ok ? response.json() as Promise<BoardResumes> : { boards: [] }))
      .then((body) => setBoards(body.boards ?? []))
      .catch(() => {});
  }, []);

  if (!boards.length) return null;

  const dismiss = () => {
    setBoards([]);
    fetch('/api/board-resumes', { method: 'POST' }).catch(() => {});
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
