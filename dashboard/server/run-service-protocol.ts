import { resolve } from 'node:path';

// Only the same OS account can open this private local socket. Never expose it
// through the public HTTP server; callers there still use normal authorization.
export const runServiceDirectory = () => process.env.OWTOMATE_RUN_SERVICE_DIR
  || resolve(import.meta.dirname, '../../seek-bot/data/run-service');
export const runServiceSocket = () => resolve(runServiceDirectory(), 'control.sock');
export const runServiceState = () => resolve(runServiceDirectory(), 'state.json');
export const usesRunService = () => process.env.OWTOMATE_RUN_SERVICE_CLIENT === '1';
export const MAX_CONTROL_BYTES = 8 * 1024 * 1024;
export const MAX_STREAM_BUFFER = 1024 * 1024;

export interface RunCompletionPolicy { chargeSubmission: boolean; releaseProxy: boolean }
export interface RunServiceSnapshot {
  pid: number;
  at: number;
  activeCount: number;
  activeUserIds: string[];
  accounts: Record<string, { state: {
    running: boolean; mode: 'search' | 'live' | null; applicationMode: 'auto' | 'semi-auto' | null;
    startedAt: string | null; finishedAt: string | null; exitCode: number | null;
    applied: number; prepared: number; ownerUserId: string | null; priorRunRepairCount?: number;
  }; runId: string | null; browserPort: number | null; inUse: boolean }>;
}
