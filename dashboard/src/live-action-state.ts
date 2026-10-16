export interface LiveMessage {
  type: 'attached' | 'ready' | 'frame' | 'navigated' | 'detached' | 'error' | 'waiting';
  workerId?: string;
  finished?: boolean;
  data?: string;
  target?: { url?: string };
  url?: string;
}

export interface LiveViewState {
  phase: 'connecting' | 'waiting' | 'live' | 'disconnected' | 'finished';
  hasPage: boolean;
  frame: string | null;
}

export const initialLiveView: LiveViewState = { phase: 'connecting', hasPage: false, frame: null };

type ViewEvent = LiveMessage | { type: 'reset' | 'closed' | 'image-error' } | { type: 'displayed'; data: string };

/** Connection readiness is not a rendered page. Never label an empty tab as live. */
export function liveViewState(state: LiveViewState, event: ViewEvent): LiveViewState {
  switch (event.type) {
    case 'reset': return initialLiveView;
    case 'attached':
    case 'navigated': {
      const url = event.type === 'attached' ? event.target?.url : event.url;
      const hasPage = Boolean(url && url !== 'about:blank' && url !== 'about:newtab');
      return { phase: 'waiting', hasPage, frame: null };
    }
    case 'ready': return { ...state, phase: state.phase === 'live' ? 'live' : 'waiting' };
    case 'waiting': return { phase: event.finished ? 'finished' : 'waiting', hasPage: false, frame: null };
    case 'frame':
      return state.hasPage && event.data
        ? { ...state, frame: `data:image/jpeg;base64,${event.data}` }
        : state;
    case 'displayed':
      return state.hasPage && event.data === state.frame ? { ...state, phase: 'live' } : state;
    case 'detached':
    case 'error':
    case 'closed':
    case 'image-error': return { ...state, phase: 'disconnected', frame: null };
    default: return state;
  }
}

export interface WorkerView { id: string; label: string; view: LiveViewState }
export type LiveStreamMessage = LiveMessage | { type: 'workers'; workers: Array<{ id: string; label: string }> };
type StreamEvent = LiveStreamMessage | { type: 'reset' | 'closed' | 'error' }
  | { type: 'displayed'; workerId: string; data: string } | { type: 'image-error'; workerId: string };
export const initialLiveWorkers: WorkerView[] = [{ id: 'main', label: 'Browser', view: initialLiveView }];

/** A frame, error or late image callback can change only its own worker. */
export function liveWorkersState(state: WorkerView[], event: StreamEvent): WorkerView[] {
  if (event.type === 'reset') return initialLiveWorkers;
  if (event.type === 'workers') {
    return event.workers.map(worker => ({ ...worker, view: state.find(old => old.id === worker.id)?.view ?? initialLiveView }));
  }
  const id = 'workerId' in event ? event.workerId : undefined;
  const broadcast = !id && (event.type === 'closed' || event.type === 'error');
  return state.map(worker => broadcast || worker.id === (id ?? 'main')
    ? { ...worker, view: liveViewState(worker.view, event) } : worker);
}
