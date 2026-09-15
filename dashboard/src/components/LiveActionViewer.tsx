import { useEffect, useState } from 'react';

interface LiveMessage {
  type: 'attached' | 'ready' | 'frame' | 'navigated' | 'detached' | 'error';
  data?: string;
  message?: string;
}

/** A one-way picture of the signed-in account's active browser. */
export function LiveActionViewer({ onClose }: { onClose: () => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState('Opening live view…');

  useEffect(() => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/screencast?quality=65&width=1440`);
    socket.addEventListener('message', (event) => {
      let update: LiveMessage;
      try {
        update = JSON.parse(String(event.data)) as LiveMessage;
      } catch {
        return;
      }
      if (update.type === 'ready') {
        setConnected(true);
        setMessage('Live');
      } else if (update.type === 'frame' && update.data) {
        setFrame(`data:image/jpeg;base64,${update.data}`);
      } else if (update.type === 'detached') {
        setConnected(false);
        setMessage('The run has ended.');
      } else if (update.type === 'error') {
        setConnected(false);
        setMessage(update.message || 'The live view is unavailable.');
      }
    });
    socket.addEventListener('close', () => setConnected(false));
    socket.addEventListener('error', () => {
      setConnected(false);
      setMessage('The live view is still getting ready. Please try again in a moment.');
    });
    return () => socket.close();
  }, []);

  return (
    <div className="overlay center live-action-overlay" role="dialog" aria-modal="true" aria-labelledby="live-action-title">
      <div className="card live-action-window">
        <div className="live-action-bar">
          <div>
            <h2 id="live-action-title">Live action</h2>
            <span className="job-meta">Watch Owtomate work in real time.</span>
          </div>
          <span className={`badge ${connected ? 'ok' : 'muted'}`}>{connected ? 'Live · view only' : message}</span>
          <button className="btn btn-small" onClick={onClose}>Close</button>
        </div>
        <div className="live-action-screen" aria-live="polite">
          {frame ? (
            <img src={frame} alt="Live browser activity" draggable={false} />
          ) : (
            <div className="live-action-waiting">
              <span className="activity-pulse" aria-hidden="true" />
              <span>{message}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
