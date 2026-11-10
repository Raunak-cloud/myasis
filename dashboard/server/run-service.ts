import { createServer, createConnection, type Socket } from 'node:net';
import { mkdirSync, chmodSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { beginAccountDeletion, AccountDeletionError } from './account-lifecycle.js';
import { MAX_CONTROL_BYTES, MAX_STREAM_BUFFER, runServiceDirectory, runServiceSocket, runServiceState } from './run-service-protocol.js';
import type { RunPool, RunMode } from './runner.js';

type Pool = Pick<RunPool, 'snapshot' | 'claimStart' | 'releaseStart' | 'start' | 'startQueue' | 'stop' |
  'stopForAccountDeletion' | 'backlog' | 'subscribe' | 'runIdFor' | 'activeCount' | 'activeUserIds' | 'pruneIdle'>;

/** The service, not an HTTP connection, owns the complete application lifetime. */
export async function serveRuns(pool: Pool) {
  mkdirSync(runServiceDirectory(), { recursive: true, mode: 0o700 });
  chmodSync(runServiceDirectory(), 0o700);
  // A dead service can leave its socket. Never unlink a live one's endpoint.
  const occupied = await new Promise<boolean>(resolve => {
    const probe = createConnection(runServiceSocket());
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  if (occupied) throw new Error('An application service is already running.');
  rmSync(runServiceSocket(), { force: true });
  const claims = new Map<string, number>();
  const deletions = new Map<string, (success: boolean) => void>();
  let draining = false;
  const sockets = new Set<Socket>();
  let warnedState = false;
  const publish = () => {
    try {
      const temporary = runServiceState() + '.' + process.pid + '.tmp';
      writeFileSync(temporary, JSON.stringify(pool.snapshot()), { mode: 0o600 });
      renameSync(temporary, runServiceState()); warnedState = false;
    } catch {
      // A full disk must not kill applications already in progress. Readers
      // reject stale state, rather than advertising an account as idle.
      if (!warnedState) console.error('[applications] cannot publish worker state; active workers remain supervised');
      warnedState = true;
    }
  };
  const reply = (socket: Socket, value: unknown, error?: Error) => {
    if (!socket.destroyed) socket.end(JSON.stringify(error ? { error: { message: error.message,
      deletion: error instanceof AccountDeletionError, status: error instanceof AccountDeletionError ? error.status : undefined } } : { value }) + '\n');
  };
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    let pending = '', bytes = 0, accepted = false;
    const decoder = new StringDecoder('utf8');
    const timeout = setTimeout(() => socket.destroy(), 10_000);
    const onData = (data: Buffer) => {
      bytes += data.length;
      if (bytes > MAX_CONTROL_BYTES) { socket.destroy(); return; }
      pending += decoder.write(data);
      const end = pending.indexOf('\n');
      if (end < 0 || accepted) return;
      accepted = true; clearTimeout(timeout); socket.off('data', onData);
      void (async () => {
        const { method, args, callerPid } = JSON.parse(pending.slice(0, end));
        pending = '';
        if (!Array.isArray(args)) throw new Error('Invalid application service request.');
        if (method === 'subscribe') {
          const [id, previousRunId, since] = args;
          if (typeof id !== 'string') throw new Error('Invalid account.');
          const send = (line: ReturnType<RunPool['backlog']>[number]) => {
            if (socket.destroyed) return;
            if (socket.writableLength > MAX_STREAM_BUFFER) { socket.destroy(); return; }
            socket.write(JSON.stringify({ runId: pool.runIdFor(id), line }) + '\n');
          };
          const unsubscribe = pool.subscribe(id, send);
          socket.once('close', unsubscribe);
          for (const line of pool.backlog(id, previousRunId === pool.runIdFor(id) && Number.isInteger(since) ? since : 0)) send(line);
          return;
        }
        if (!Number.isInteger(callerPid) || callerPid < 1) throw new Error('Invalid application service caller.');
        if (['claimStart', 'start', 'startQueue'].includes(method) && draining) throw new Error('Application service is updating. Try again shortly.');
        let value: unknown;
        switch (method) {
          case 'claimStart':
            value = pool.claimStart(args[0]);
            if (value) claims.set(args[0], callerPid);
            break;
          case 'releaseStart':
            if (claims.get(args[0]) === callerPid) { claims.delete(args[0]); pool.releaseStart(args[0]); }
            break;
          case 'start':
            value = await pool.start(args[0] as RunMode, args[1], args[2], undefined, undefined, args[3], args[4], args[5]);
            break;
          case 'startQueue': value = await pool.startQueue(args[0], args[1], args[2]); break;
          case 'stop': value = pool.stop(args[0]); break;
          case 'stopForAccountDeletion':
            if (!deletions.has(args[0])) deletions.set(args[0], beginAccountDeletion(args[0]));
            try { await pool.stopForAccountDeletion(args[0]); }
            catch (error) { deletions.get(args[0])?.(false); deletions.delete(args[0]); throw error; }
            break;
          case 'finishAccountDeletion': deletions.get(args[0])?.(Boolean(args[1])); deletions.delete(args[0]); break;
          default: throw new Error('Unknown application service operation.');
        }
        publish(); reply(socket, value);
      })().catch(error => { publish(); reply(socket, undefined, error as Error); });
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    socket.once('close', () => clearTimeout(timeout));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(runServiceSocket(), resolve);
  });
  chmodSync(runServiceSocket(), 0o600);
  publish();
  const heartbeat = setInterval(() => {
    for (const [id, pid] of claims) {
      try { process.kill(pid, 0); }
      catch { claims.delete(id); pool.releaseStart(id); }
    }
    pool.pruneIdle(); publish();
  }, 500);
  return { server, publish,
    async drain() {
      draining = true;
      // Service releases are normally deployed after runs drain. If an
      // operator restarts it early, let existing applications finish.
      while (pool.activeCount() > 0) await new Promise(resolve => setTimeout(resolve, 500));
      clearInterval(heartbeat);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(runServiceSocket(), { force: true });
    },
  };
}
