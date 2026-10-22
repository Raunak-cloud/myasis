import { randomBytes, randomUUID } from 'node:crypto';
import type { SigninDesktop } from './signin-desktop.js';
import type { SigninAssistStatus } from './signin-assist.js';

export type SigninTarget = 'seek' | 'indeed';
export interface SigninSession {
  id: string;
  userId: string;
  display: number;
  vncPort: number;
  password: string;
  startedAt: number;
  expiresAt: number;
  target: SigninTarget;
  state: SigninDesktop['state'];
  revision: number;
  message: string;
  assist?: SigninAssistStatus;
}
interface Entry {
  session: SigninSession;
  desktop?: SigninDesktop;
  task: Promise<void>;
  cancelled: boolean;
  timer?: NodeJS.Timeout;
}

/** Per-account single flight, plus cleanup barriers and generation identity.
 * A late exit from a previous browser can never close a new session.
 */
export class SigninSessions {
  private entries = new Map<string, Entry>();
  private closing = new Map<string, Promise<void>>();
  private closingSessions = new Map<string, SigninSession>();
  private prepare: (session: SigninSession, assist: boolean) => Promise<SigninDesktop>;
  private duration: number;
  constructor(prepare: (session: SigninSession, assist: boolean) => Promise<SigninDesktop>, duration = 15 * 60_000) {
    this.prepare = prepare; this.duration = duration;
  }

  sessionFor(userId: string): SigninSession | null {
    const entry = this.entries.get(userId);
    if (!entry) return this.closingSessions.get(userId) ?? null;
    const desktop = entry.desktop;
    return { ...entry.session, ...(desktop ? { display: desktop.display, vncPort: desktop.vncPort,
      state: desktop.state, revision: desktop.revision, message: desktop.message } : {}) };
  }
  count() { return new Set([...this.entries.keys(), ...this.closing.keys()]).size; }
  desktopFor(userId: string) { return this.entries.get(userId)?.desktop; }

  async start(userId: string, target: SigninTarget, assist = true, expiresAt?: number): Promise<{ok: boolean; session?: SigninSession; error?: string}> {
    let entry = this.entries.get(userId);
    if (entry?.desktop?.state === 'failed') { await this.stop(userId); return this.start(userId, target, assist, expiresAt); }
    if (!entry) {
      const now = Date.now();
      if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= now)) return {ok: false, error: 'The sign-in window expired. Please open it again.'};
      const session: SigninSession = { id: randomUUID(), userId, target, password: randomBytes(8).toString('base64url').slice(0, 8),
        display: 0, vncPort: 0, startedAt: now, expiresAt: Math.min(now + this.duration, expiresAt ?? Infinity),
        state: 'starting', revision: 0, message: 'Opening the sign-in browser...' };
      entry = { session, cancelled: false, task: Promise.resolve() };
      // Claim the account before prepare/route/profile cleanup can yield.
      this.entries.set(userId, entry);
      const current = entry;
      const priorCleanup = this.closing.get(userId);
      current.timer = setTimeout(() => void this.stopIfCurrent(userId, current), session.expiresAt - now);
      current.timer.unref();
      current.task = (async () => {
        await priorCleanup;
        if (current.cancelled) return;
        const desktop = await this.prepare(session, assist);
        current.desktop = desktop;
        if (current.cancelled) { await desktop.stop(); return; }
        await desktop.start();
      })();
      // A caller may navigate away before the launch completes.
      void current.task.catch(() => {});
    }
    const current = entry;
    try {
      await current.task;
      if (current.cancelled || this.entries.get(userId) !== current) return { ok: false, error: 'Sign-in was closed.' };
      const session = this.sessionFor(userId)!;
      if (session.state === 'failed') return { ok: false, error: session.message };
      return { ok: true, session };
    } catch (error) {
      await this.stopIfCurrent(userId, current);
      return { ok: false, error: (error as Error).message };
    }
  }

  private stopIfCurrent(userId: string, entry: Entry): Promise<{ok: boolean}> {
    return this.entries.get(userId) === entry ? this.stop(userId) : Promise.resolve({ok: false});
  }

  stop(userId: string): Promise<{ok: boolean}> {
    const entry = this.entries.get(userId);
    if (!entry) return (this.closing.get(userId) ?? Promise.resolve()).then(() => ({ok: false}));
    this.closingSessions.set(userId, {...this.sessionFor(userId)!, state: 'closed', message: 'Closing the sign-in browser...'});
    this.entries.delete(userId);
    entry.cancelled = true;
    clearTimeout(entry.timer);
    // Start stopping immediately, then await any launch still in flight.
    const immediateStop = entry.desktop?.stop();
    const cleanup = (async () => {
      await immediateStop;
      await entry.task.catch(() => {});
      await entry.desktop?.stop();
    })().finally(() => {
      if (this.closing.get(userId) === cleanup) { this.closing.delete(userId); this.closingSessions.delete(userId); }
    });
    this.closing.set(userId, cleanup);
    return cleanup.then(() => ({ok: true}));
  }
  stopAll(): Promise<void> {
    const stops = [...this.entries.keys()].map(userId => this.stop(userId));
    return Promise.all([...stops, ...this.closing.values()]).then(() => {});
  }
}
