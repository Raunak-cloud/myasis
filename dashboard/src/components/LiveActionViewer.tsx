import { useEffect, useReducer, useState } from 'react';
import { initialLiveView, liveViewState } from '../live-action-state';
import type { LiveMessage } from '../live-action-state';

/** A one-way picture of the signed-in account's active browser. */
export function LiveActionViewer({ onClose, activity }: { onClose: () => void; activity?: string }) {
  const [view, updateView] = useReducer(liveViewState, initialLiveView);
  const [attempt, setAttempt] = useState(0);
  const live = view.phase === 'live';
  const disconnected = view.phase === 'disconnected';
  const message = disconnected ? 'Live view disconnected' : 'Waiting for a browser page';

  useEffect(() => {
    updateView({ type: 'reset' });
    let disposed = false;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/screencast?quality=82&width=1440`);
    socket.addEventListener('message', (event) => {
      if (disposed) return;
      let update: LiveMessage;
      try {
        update = JSON.parse(String(event.data)) as LiveMessage;
      } catch {
        return;
      }
      updateView(update);
    });
    socket.addEventListener('close', () => { if (!disposed) updateView({ type: 'closed' }); });
    socket.addEventListener('error', () => {
      if (!disposed) updateView({ type: 'error' });
    });
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
          <span className={`badge ${live ? 'ok' : 'muted'}`}>{live ? 'Live · view only' : disconnected ? 'Disconnected' : view.phase === 'connecting' ? 'Connecting · view only' : 'Waiting · view only'}</span>
          <button className="btn btn-small" onClick={onClose}>Close</button>
        </div>
        <div className="live-action-screen">
          {view.frame && (
            <img src={view.frame} alt="Live browser activity" draggable={false}
              style={!live ? { visibility: 'hidden' } : undefined}
              onLoad={(event) => updateView({ type: 'displayed', data: event.currentTarget.src })}
              onError={() => updateView({ type: 'image-error' })} />
          )}
          {!live && (
            <div className="live-action-waiting" role="status">
              <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="5" y="7" width="38" height="28" rx="4" /><path d="M5 15h38M17 41h14M24 35v6" />
                <circle cx="11" cy="11" r="1" fill="currentColor" stroke="none" />
              </svg>
              <h3>{message}</h3>
              <p>{disconnected
                ? 'The browser picture is unavailable. Check the run activity below, or reconnect the view.'
                : 'Job searches and AI reviews can happen without a browser page. The picture will appear when a page opens.'}</p>
              {disconnected && <button className="btn btn-small" onClick={() => setAttempt((value) => value + 1)}>Retry live view</button>}
            </div>
          )}
        </div>
        <div className="live-action-progress" role="status">
          <span className="activity-pulse" aria-hidden="true" />
          <div><span className="job-meta">Latest run activity</span><strong>{activity || 'Waiting for the next run update…'}</strong></div>
        </div>
      </div>
    </div>
  );
}
