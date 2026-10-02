import { useEffect, useState } from 'react';

/**
 * Résumés saved on SEEK or Indeed that Owtomate does not hold.
 *
 * Applications always send the résumé in Owtomate, never one of these, so a
 * person who uploads a new CV straight to SEEK would otherwise wonder why
 * employers are not getting it. Said once, with the way to use one; hidden
 * for good once dismissed, until the list changes.
 */
interface BoardResumes { boards: Array<{ board: 'seek' | 'indeed'; names: string[] }> }

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

  const signature = boards.map((entry) => `${entry.board}:${entry.names.join('|')}`).join(';');
  if (!boards.length || dismissed === signature) return null;

  const dismiss = () => {
    try { localStorage.setItem('board-resumes-dismissed', signature); } catch { /* the note simply returns next visit */ }
    setDismissed(signature);
  };

  return (
    <div className="banner board-resumes-note" role="note">
      <div>
        {boards.map((entry) => (
          <p key={entry.board}>
            <strong>{BOARD[entry.board]}</strong> has {entry.names.length === 1 ? 'a résumé' : 'résumés'} Owtomate doesn't send:{' '}
            {entry.names.join(', ')}.
          </p>
        ))}
        <p className="job-meta">Applications always send the résumé in Owtomate. To use one of these instead, upload it in Setup.</p>
      </div>
      <div className="board-resumes-actions">
        <a className="btn btn-small" href="/?tab=setup">Upload in Setup</a>
        <button type="button" className="link-button" onClick={dismiss}>Dismiss</button>
      </div>
    </div>
  );
}
