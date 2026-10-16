import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LiveWorkerId } from './live-workers.js';

export const REMOTE_PREVIEW_FILE = 'remote-browser-preview.json';
export const LIVE_VIEW_REQUEST_FILE = 'live-view-request.json';
export const remotePreviewFile = (id: LiveWorkerId = 'main') => id === 'main' ? REMOTE_PREVIEW_FILE : `remote-browser-preview-${id}.json`;
export interface RemoteBrowserPreview {
  sessionId: string;
  provider: 'brightdata';
  at: number;
  url: string;
  data: string | null;
}

/** Fixed account-owned path; expired, partial and oversized pictures are never presented as live. */
export function readRemoteBrowserPreview(directory: string, now = Date.now(), worker: LiveWorkerId = 'main'): RemoteBrowserPreview | null {
  try {
    const file = resolve(directory, remotePreviewFile(worker));
    if (!existsSync(file) || statSync(file).size > 4_000_000) return null;
    const frame = JSON.parse(readFileSync(file, 'utf8')) as RemoteBrowserPreview;
    if (frame.provider !== 'brightdata' || typeof frame.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(frame.sessionId)
      || !Number.isFinite(frame.at) || frame.at > now + 1000 || now - frame.at > 8_000
      || typeof frame.url !== 'string' || frame.url.length > 500
      || !(frame.url === 'about:blank' || /^https?:\/\//.test(frame.url))
      || (frame.data !== null && (typeof frame.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(frame.data)))) return null;
    return frame;
  } catch { return null; }
}
