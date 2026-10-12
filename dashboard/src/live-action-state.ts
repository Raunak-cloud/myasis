export interface LiveMessage {
  type: 'attached' | 'ready' | 'frame' | 'navigated' | 'detached' | 'error';
  data?: string;
  target?: { url?: string };
  url?: string;
}

export interface LiveViewState {
  phase: 'connecting' | 'waiting' | 'live' | 'disconnected';
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
