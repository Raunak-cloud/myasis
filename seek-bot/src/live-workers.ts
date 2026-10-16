import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type LiveWorkerId = 'main' | 'seek' | 'indeed';
export const LIVE_WORKERS_FILE = 'live-workers.json';
export const LIVE_WORKER_LABELS: Record<LiveWorkerId, string> = {
  main: 'Browser', seek: 'SEEK worker', indeed: 'Indeed / employer feeds worker',
};
export interface LiveWorker { id: LiveWorkerId; label: string }
export interface LiveTarget { targetId?: string; finished?: boolean }
export const liveTargetFile = (id: LiveWorkerId) => id === 'main' ? 'live-target.json' : `live-target-${id}.json`;

function atomicWrite(directory: string, name: string, value: unknown): void {
  mkdirSync(directory, { recursive: true });
  const file = resolve(directory, name), temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

/** Only the coordinator changes the roster; workers write separate target files. */
export function configureLiveWorkers(directory: string, ids: LiveWorkerId[]): void {
  atomicWrite(directory, LIVE_WORKERS_FILE, { workers: ids });
}
export function resetLiveWorkers(directory: string): void {
  for (const id of ['main', 'seek', 'indeed'] as const) {
    for (const file of [liveTargetFile(id), id === 'main' ? 'remote-browser-preview.json' : `remote-browser-preview-${id}.json`]) {
      try { unlinkSync(resolve(directory, file)); } catch { /* No previous run. */ }
    }
  }
  configureLiveWorkers(directory, ['main']);
}
export function writeLiveTarget(directory: string, id: LiveWorkerId, target: LiveTarget): void {
  atomicWrite(directory, liveTargetFile(id), target);
}
export function readLiveTarget(directory: string, id: LiveWorkerId): LiveTarget | null {
  try {
    const target = JSON.parse(readFileSync(resolve(directory, liveTargetFile(id)), 'utf8'));
    return { ...(typeof target.targetId === 'string' ? { targetId: target.targetId } : {}), ...(target.finished === true ? { finished: true } : {}) };
  } catch { return null; }
}
export function readLiveWorkers(directory: string): LiveWorker[] {
  try {
    const { workers } = JSON.parse(readFileSync(resolve(directory, LIVE_WORKERS_FILE), 'utf8'));
    if (Array.isArray(workers) && workers.length > 0 && workers.length <= 2
      && new Set(workers).size === workers.length && workers.every(id => Object.hasOwn(LIVE_WORKER_LABELS, id))) {
      return workers.map((id: LiveWorkerId) => ({ id, label: LIVE_WORKER_LABELS[id] }));
    }
  } catch { /* Legacy runs expose one browser. */ }
  return [{ id: 'main', label: LIVE_WORKER_LABELS.main }];
}
