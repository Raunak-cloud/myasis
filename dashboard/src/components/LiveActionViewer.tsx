import { useEffect, useReducer, useState } from 'react';
import { initialLiveWorkers, liveWorkersState } from '../live-action-state';
import type { LiveStreamMessage } from '../live-action-state';
import { plainReason } from '../run-messages';

const ACTIVITY_LABEL = {
  starting: 'Getting ready', reviewing: 'Reviewing jobs', applying: 'Applying',
  waiting: 'Waiting', cooldown: 'Pausing between jobs', finished: 'Activity ended',
};

/** Independent, view-only pictures of this account's application workers. */
export function LiveActionViewer({ onClose, activity, preparing = false }: { onClose: () => void; activity?: string; preparing?: boolean }) {
  const [workers, updateView] = useReducer(liveWorkersState, initialLiveWorkers);
  const [attempt, setAttempt] = useState(0);
  const liveCount = workers.filter(worker => worker.view.phase === 'live').length;

  useEffect(() => {
    updateView({ type: 'reset' });
    let disposed = false;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/screencast?quality=82&width=1440`);
    socket.addEventListener('message', (event) => {
      if (disposed) return;
      let update: LiveStreamMessage;
      try { update = JSON.parse(String(event.data)) as LiveStreamMessage; } catch { return; }
      updateView(update);
    });
    socket.addEventListener('close', () => { if (!disposed) updateView({ type: 'closed' }); });
    socket.addEventListener('error', () => { if (!disposed) updateView({ type: 'error' }); });
    return () => { disposed = true; socket.close(); };
  }, [attempt]);

  return (
    <div className="overlay center live-action-overlay" role="dialog" aria-modal="true" aria-labelledby="live-action-title">
      <div className="card live-action-window">
        <div className="live-action-bar">
          <div>
            <h2 id="live-action-title">Live action</h2>
            <span className="job-meta">Watch Owtomate work in real time.</span>
          </div>
          <span className={`badge ${liveCount ? 'ok' : 'muted'}`}>{workers.length > 0 && workers.every(worker => worker.view.phase === 'finished') ? 'Live activity ended' : workers.length > 1 ? `${liveCount} of ${workers.length} pictures live` : liveCount ? 'Picture live' : 'Connecting'} · view only</span>
          <button className="btn btn-small" onClick={onClose}>Close</button>
        </div>
        <div className={`live-action-grid${workers.length > 1 ? ' parallel' : ''}`}>
          {workers.map(({ id, label, view, activity: workerActivity }) => {
            const live = view.phase === 'live';
            const disconnected = view.phase === 'disconnected';
            const finished = view.phase === 'finished';
            const activityLabel = workerActivity ? workerActivity.phase === 'applying' && preparing ? 'Preparing' : ACTIVITY_LABEL[workerActivity.phase] : null;
            const pageLess = workerActivity && workerActivity.phase !== 'applying' && workerActivity.phase !== 'reviewing';
            return (
              <section className="live-action-worker" key={id} aria-label={label}>
                <div className="live-action-worker-bar">
                  <strong>{label}</strong>
                  <div className="live-action-worker-status">
                    {activityLabel && <span className={`badge ${workerActivity?.phase === 'applying' ? 'ok' : 'info'}`}>{activityLabel}</span>}
                    <span className={`badge ${live ? 'ok' : 'muted'}`}>{disconnected ? 'Disconnected' : live ? 'Picture live' : pageLess || finished ? 'No live picture' : 'Waiting for picture'}</span>
                  </div>
                </div>
                {workerActivity?.detail && !pageLess && <p className="live-action-worker-detail">{plainReason(workerActivity.detail)}</p>}
                <div className="live-action-screen">
                  {view.frame && (
                    <img src={view.frame} alt={`${label} live browser activity`} draggable={false}
                      style={!live ? { visibility: 'hidden' } : undefined}
                      onLoad={(event) => updateView({ type: 'displayed', workerId: id, data: event.currentTarget.src })}
                      onError={() => updateView({ type: 'image-error', workerId: id })} />
                  )}
                  {!live && (
                    <div className="live-action-waiting" role="status">
                      <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <rect x="5" y="7" width="38" height="28" rx="4" /><path d="M5 15h38M17 41h14M24 35v6" />
                        <circle cx="11" cy="11" r="1" fill="currentColor" stroke="none" />
                      </svg>
                      <h3>{finished ? 'Live activity ended' : disconnected ? 'Live view disconnected' : pageLess ? activityLabel : 'Waiting for an application page'}</h3>
                      <p>{finished ? 'Check Activity for the application results.' : disconnected
                        ? 'The live picture is unavailable. Check Activity below, or reconnect the view.'
                        : pageLess ? workerActivity?.detail ? plainReason(workerActivity.detail) : 'Waiting for the next application.'
                        : 'Owtomate is reviewing jobs. A live picture will appear when an application page opens.'}</p>
                      {disconnected && <button className="btn btn-small" onClick={() => setAttempt(value => value + 1)}>Reconnect views</button>}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
        <div className="live-action-progress" role="status">
          <span className="activity-pulse" aria-hidden="true" />
          <div><span className="job-meta">Latest run activity</span><strong>{activity ? plainReason(activity) : 'Waiting for the next run update…'}</strong></div>
        </div>
      </div>
    </div>
  );
}
