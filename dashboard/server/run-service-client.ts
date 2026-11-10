import { createConnection } from 'node:net';
import { readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { userDir } from './userdata.js';
import { StringDecoder } from 'node:string_decoder';
import { accountUnavailable, AccountDeletionError } from './account-lifecycle.js';
import { browserBenchmarkInProgress } from './browser-benchmark-lock.js';
import { MAX_CONTROL_BYTES, runServiceSocket, runServiceState, type RunCompletionPolicy, type RunServiceSnapshot } from './run-service-protocol.js';
import type { RunPool, RunMode } from './runner.js';

type Line = ReturnType<RunPool['backlog']>[number];
const idle = { running: false, mode: null, applicationMode: null, startedAt: null,
  finishedAt: null, exitCode: null, applied: 0, prepared: 0, ownerUserId: null };

export function runServiceRequest<T>(method: string, args: unknown[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(runServiceSocket());
    let pending = '';
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => socket.destroy(new Error('Application service did not respond.')), 180_000);
    socket.once('connect', () => socket.write(JSON.stringify({ method, args, callerPid: process.pid }) + '\n'));
    socket.on('data', data => {
      pending += decoder.write(data);
      if (pending.length > MAX_CONTROL_BYTES) { socket.destroy(new Error('Application service response is too large.')); return; }
      const end = pending.indexOf('\n');
      if (end < 0) return;
      try {
        const result = JSON.parse(pending.slice(0, end));
        if (result.error) reject(result.error.deletion
          ? new AccountDeletionError(result.error.message, result.error.status)
          : new Error(result.error.message));
        else resolve(result.value);
      } catch (error) { reject(error); }
      socket.end();
    });
    socket.once('error', reject);
    socket.once('close', () => { clearTimeout(timer); reject(new Error('Application service is unavailable. Try again shortly.')); });
  });
}

/** A new dashboard reconnects to the same workers, including their Gmail
 * capability, watchdog, billing and final persistence. It never adopts or
 * relaunches a browser based on a stale database row. */
export class RemoteRunPool {
  private snapshot(): RunServiceSnapshot {
    const state = JSON.parse(readFileSync(runServiceState(), 'utf8')) as RunServiceSnapshot;
    if (Date.now() - state.at > 10_000) throw new Error('Application service is reconnecting. Try again shortly.');
    process.kill(state.pid, 0);
    return state;
  }
  activeCount() { return this.snapshot().activeCount; }
  activeUserIds() { return this.snapshot().activeUserIds; }
  anyRunning() { return this.activeCount() > 0; }
  stateFor(id: string) { return this.snapshot().accounts[id]?.state ?? { ...idle }; }
  runIdFor(id: string) { return this.snapshot().accounts[id]?.runId ?? null; }
  browserPortFor(id: string) { return this.snapshot().accounts[id]?.browserPort ?? null; }
  inUse(id: string) { return accountUnavailable(id) || browserBenchmarkInProgress(id) || Boolean(this.snapshot().accounts[id]?.inUse); }
  claimStart(id: string) { return runServiceRequest<boolean>('claimStart', [id]); }
  releaseStart(id: string) { return runServiceRequest<void>('releaseStart', [id]); }
  stop(id: string) { return runServiceRequest<{ ok: boolean; error?: string }>('stop', [id]); }
  stopForAccountDeletion(id: string) { return runServiceRequest<void>('stopForAccountDeletion', [id]); }
  finishAccountDeletion(id: string, success: boolean) { return runServiceRequest<void>('finishAccountDeletion', [id, success]); }
  // Shutdown of a dashboard closes viewers only. Applications belong to the service.
  async stopAll() { /* Deliberately no RPC that stops every user's application. */ }
  start(mode: RunMode, overrides: Record<string, string>, id: string,
    _onSubmitted?: (external: boolean) => void | Promise<void>, _onFinished?: () => void | Promise<void>,
    runId?: string | null, repairCaseId?: string, policy?: RunCompletionPolicy) {
    if (_onSubmitted || _onFinished) throw new Error('Application cleanup must be owned by the application service.');
    return runServiceRequest<{ ok: boolean; error?: string }>('start', [mode, overrides, id, runId, repairCaseId, policy]);
  }
  startQueue(id: string, overrides: Record<string, string> = {}, runId?: string | null) {
    return runServiceRequest<{ ok: boolean; error?: string }>('startQueue', [id, overrides, runId]);
  }
  // The stream replays the bounded live backlog. Consumers already deduplicate
  // sequence numbers; a new run resets both its identity and sequence.
  backlog(id: string, since = 0): Line[] {
    const runId = this.runIdFor(id);
    if (!runId || !/^\d+$/.test(runId)) return [];
    let fd: number | undefined;
    try {
      fd = openSync(resolve(userDir(id), 'run-logs', runId + '.jsonl'), 'r');
      const size = fstatSync(fd).size, start = Math.max(0, size - 2 * 1024 * 1024);
      const buffer = Buffer.alloc(size - start); readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      if (start) lines.shift();
      return lines.flatMap(raw => { try { const line = JSON.parse(raw); return line.seq > since ? [line] : []; } catch { return []; } }).slice(-2000);
    } catch { return []; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  subscribe(id: string, fn: (line: Line) => void) {
    let disposed = false, runId: string | null = null, since = 0;
    let socket: ReturnType<typeof createConnection> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed) return;
      socket = createConnection(runServiceSocket());
      let pending = '';
      const decoder = new StringDecoder('utf8');
      socket.once('connect', () => socket!.write(JSON.stringify({ method: 'subscribe', args: [id, runId, since] }) + '\n'));
      socket.on('data', data => {
        pending += decoder.write(data);
        if (pending.length > MAX_CONTROL_BYTES) { socket?.destroy(); return; }
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const raw = pending.slice(0, end); pending = pending.slice(end + 1);
          try {
            const message = JSON.parse(raw);
            if (message.runId !== runId) { runId = message.runId; since = 0; }
            if (message.line?.seq > since) { since = message.line.seq; fn(message.line); }
          } catch { /* A broken stream reconnects to persisted worker state. */ }
        }
      });
      socket.on('error', () => {});
      socket.once('close', () => { if (!disposed) { retry = setTimeout(connect, 1000); retry.unref(); } });
    };
    connect();
    return () => { disposed = true; clearTimeout(retry); socket?.destroy(); };
  }
}
