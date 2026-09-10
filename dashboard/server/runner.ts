import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { exportUserForRun, syncRunResultsToDb } from './db/run-sync.js';

// `import.meta.dirname` — Vite's native config loader deprecates __dirname.
export const BOT_DIR = resolve(import.meta.dirname, '..', '..', 'seek-bot');
const ENV_PATH = resolve(BOT_DIR, '.env');

export type RunMode = 'search' | 'rehearse' | 'live';

export interface LogLine {
  seq: number;
  ts: string;
  stream: 'out' | 'err' | 'sys';
  text: string;
}

export interface RunState {
  running: boolean;
  mode: RunMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  applied: number;
  /**
   * Which account's run this is. Kept on the state even though runs are now
   * per-account, because the finished-run summary lingers after the child
   * exits and the API still checks ownership before showing it.
   */
  ownerUserId: string | null;
}

const MAX_LINES = 2000;

/**
 * How many accounts may run at once.
 *
 * Each run holds a headed Chrome, which is roughly 1.2 GB of RAM and a real
 * share of a CPU core, so this is a memory ceiling rather than a policy. On a
 * 4 GB box one run is all that fits; 8 GB comfortably holds three. Set
 * MAX_CONCURRENT_RUNS to match the machine.
 */
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_RUNS ?? 3));

const IDLE_STATE: RunState = {
  running: false,
  mode: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  applied: 0,
  ownerUserId: null,
};

export async function assertHumanizerHealthy(overrides: Record<string, string> = {}): Promise<void> {
  const fileEnv = readEnv();
  if ((overrides.HUMANIZER_REQUIRED ?? process.env.HUMANIZER_REQUIRED ?? fileEnv.HUMANIZER_REQUIRED) !== 'true') return;
  const base = (
    overrides.HUMANIZER_URL ??
    process.env.HUMANIZER_URL ??
    fileEnv.HUMANIZER_URL ??
    ''
  ).replace(/\/$/, '');

  if (!base) {
    throw new Error(
      'AuthorMist is required but HUMANIZER_URL is not configured. Start it in seek-bot with `npm run humanizer`.',
    );
  }

  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `AuthorMist is required but is not ready. Start it in seek-bot with \`npm run humanizer\`, wait for the model to load, then try again. (${(error as Error).message})`,
    );
  }
}

/**
 * One account's run: its child process, its console and its state.
 *
 * Everything here used to be installation-wide, which meant one run at a time
 * for everybody and one account's console visible in the pool. Per-account
 * instances are what make concurrent runs possible; the other half of that is
 * a per-account Chrome profile (see `userChromeDir`), because Chrome locks a
 * profile directory against a second process.
 */
class Run {
  private child: ChildProcess | null = null;
  private onApplicationSubmitted: (() => void | Promise<void>) | null = null;
  private onRehearsalCompleted: (() => void | Promise<void>) | null = null;
  private lines: LogLine[] = [];
  private seq = 0;
  private listeners = new Set<(l: LogLine) => void>();
  readonly userId: string;
  state: RunState;

  constructor(userId: string) {
    this.userId = userId;
    this.state = { ...IDLE_STATE, ownerUserId: userId };
  }

  private push(stream: LogLine['stream'], text: string) {
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const line: LogLine = {
        seq: ++this.seq,
        ts: new Date().toISOString(),
        stream,
        text: raw,
      };
      this.lines.push(line);
      if (this.lines.length > MAX_LINES) this.lines.shift();
      // Cheap progress signal for the UI without re-reading applied.json.
      if (/✅ submitted/.test(raw)) {
        this.state.applied++;
        if (this.onApplicationSubmitted) {
          void Promise.resolve(this.onApplicationSubmitted()).catch((error) =>
            this.push('err', `Could not record application usage: ${(error as Error).message}`),
          );
        }
      }
      if (/🧪 rehearsed/.test(raw) && this.onRehearsalCompleted) {
        void Promise.resolve(this.onRehearsalCompleted()).catch((error) =>
          this.push('err', `Could not record rehearsal usage: ${(error as Error).message}`),
        );
      }
      for (const fn of this.listeners) fn(line);
    }
  }

  subscribe(fn: (l: LogLine) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  backlog(since = 0): LogLine[] {
    return this.lines.filter((l) => l.seq > since);
  }

  get running(): boolean {
    return this.state.running;
  }

  /**
   * True once the run has ended and nobody is watching its console any more.
   *
   * `finishedAt` is the load-bearing part. A run is not marked running until
   * its data export finishes, so testing `running` alone let a second
   * account's start sweep away a run that was still being prepared — its
   * child then spawned against an orphaned object, invisible and unstoppable.
   */
  get disposable(): boolean {
    return !this.state.running && this.state.finishedAt !== null && this.listeners.size === 0;
  }

  /**
   * Spawns the bot as a child process with per-run env overrides, so a
   * dashboard run never has to rewrite .env to change its behaviour.
   *
   * Before spawning, this exports `userId`'s Postgres-backed profile,
   * résumés, knowledge and application history into that account's own
   * `seek-bot/data/users/<userId>/` directory (see `db/run-sync.ts`) and
   * points the child at it via `DATA_DIR` — the same override mechanism as
   * `MIN_SCORE` etc. — so a run started as one account can only ever see and
   * write that account's own files, never another account's.
   */
  async start(
    mode: RunMode,
    overrides: Record<string, string>,
    onApplicationSubmitted?: () => void | Promise<void>,
    onRehearsalCompleted?: () => void | Promise<void>,
  ): Promise<{ ok: boolean; error?: string }> {
    const userId = this.userId;
    if (this.state.running) return { ok: false, error: 'A run is already in progress for this account.' };
    if (!existsSync(resolve(BOT_DIR, 'dist', 'main.js'))) {
      return { ok: false, error: 'seek-bot is not built. Run `npm run build` in seek-bot first.' };
    }
    try {
      await assertHumanizerHealthy(overrides);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }

    let dataDir: string;
    let profileOverrides: Record<string, string>;
    try {
      const exported = await exportUserForRun(userId);
      dataDir = exported.dir;
      profileOverrides = exported.overrides;
    } catch (error) {
      return { ok: false, error: `Could not prepare this account's data for the run: ${(error as Error).message}` };
    }

    const args = ['dist/main.js'];
    if (mode === 'search') args.push('--search-only');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...overrides,
      // After `overrides`, deliberately: these carry the account's identity
      // (whose profile.txt, whose experience/skills, whose Chrome profile)
      // and must never be settable by a caller-supplied override.
      ...profileOverrides,
      // Rehearse fills every form but withholds the final submit.
      DRY_RUN: mode === 'live' ? 'false' : 'true',
      ...(mode === 'rehearse' ? { REHEARSE: 'true' } : {}),
      // Always last: no override may point a run at another account's files.
      DATA_DIR: dataDir,
    };

    this.lines = [];
    this.seq = 0;
    this.onApplicationSubmitted = onApplicationSubmitted ?? null;
    this.onRehearsalCompleted = onRehearsalCompleted ?? null;
    this.state = {
      running: true,
      mode,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      applied: 0,
      ownerUserId: userId,
    };

    this.push('sys', `▶ starting ${mode} run`);
    const shown = Object.entries(overrides)
      .map(([k, v]) => `${k}=${['COVER_LETTER_TEXT_B64', 'AI_INSTRUCTIONS_B64'].includes(k) ? '<provided>' : v}`)
      .join('  ');
    if (shown) this.push('sys', `  overrides: ${shown}`);
    if (mode === 'live') this.push('sys', '  ⚠ LIVE — applications will be submitted');

    this.spawnChild(spawn(process.execPath, args, { cwd: BOT_DIR, env }), userId, dataDir, 'run');
    return { ok: true };
  }

  /**
   * Runs the queue builder — discovery, scoring and drafting only. It opens no
   * application form, so unlike `start()` there is nothing here that needs a
   * confirmation gate. Same per-account export/sync as `start()` — the scan
   * still reads this account's résumés/knowledge/applied-jobs history to
   * dedupe and draft, off `DATA_DIR`, not the shared folder.
   */
  async startQueue(overrides: Record<string, string> = {}): Promise<{ ok: boolean; error?: string }> {
    const userId = this.userId;
    if (this.state.running) return { ok: false, error: 'A scan is already running for this account.' };
    if (!existsSync(resolve(BOT_DIR, 'dist', 'queue.js'))) {
      return { ok: false, error: 'seek-bot is not built. Run `npm run build` in seek-bot first.' };
    }
    try {
      await assertHumanizerHealthy();
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }

    let dataDir: string;
    let profileOverrides: Record<string, string>;
    try {
      const exported = await exportUserForRun(userId);
      dataDir = exported.dir;
      profileOverrides = exported.overrides;
    } catch (error) {
      return { ok: false, error: `Could not prepare this account's data for the scan: ${(error as Error).message}` };
    }

    this.lines = [];
    this.seq = 0;
    this.state = {
      running: true,
      mode: 'search',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      applied: 0,
      ownerUserId: userId,
    };
    this.push('sys', '▶ scanning SEEK for new matches');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...overrides,
      // After `overrides`, deliberately — see the same ordering in start().
      ...profileOverrides,
      // Always last: no override may point a scan at another account's files.
      DATA_DIR: dataDir,
    };
    this.spawnChild(spawn(process.execPath, ['dist/queue.js'], { cwd: BOT_DIR, env }), userId, dataDir, 'scan');
    return { ok: true };
  }

  /** Wiring shared by a run and a scan: console piping, exit handling, result sync. */
  private spawnChild(child: ChildProcess, userId: string, dataDir: string, kind: 'run' | 'scan'): void {
    this.child = child;
    child.stdout?.on('data', (b) => this.push('out', b.toString()));
    child.stderr?.on('data', (b) => this.push('err', b.toString()));
    child.on('error', (e) => this.push('err', `spawn failed: ${e.message}`));
    child.on('close', (code) => {
      this.state.running = false;
      this.state.exitCode = code;
      this.state.finishedAt = new Date().toISOString();
      this.child = null;
      this.onApplicationSubmitted = null;
      this.onRehearsalCompleted = null;
      this.push('sys', `■ ${kind} finished (exit ${code})`);
      // Fold what this run actually did — new applications, run events — back
      // into userId's Postgres rows. `syncRunResultsToDb` is idempotent (ON
      // CONFLICT DO NOTHING on natural keys), so this can never double-count
      // even if it were somehow triggered twice for the same run.
      void syncRunResultsToDb(userId, dataDir)
        .then((r) => this.push('sys', `  synced ${r.applications} application(s), ${r.runEvents} event(s) to your account`))
        .catch((error) => this.push('err', `Could not save this ${kind}'s results: ${(error as Error).message}`));
    });
  }

  stop(): { ok: boolean; error?: string } {
    if (!this.child) return { ok: false, error: 'Nothing is running.' };
    this.push('sys', '⏹ stop requested — terminating');
    // Windows needs the tree killed; the bot owns a Chrome child process.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F']);
    } else {
      this.child.kill('SIGTERM');
    }
    return { ok: true };
  }
}

/**
 * Every account's run, keyed by account.
 *
 * Runs are independent: one account's failure, console and stop button never
 * touch another's. The only shared resource left is the machine itself, which
 * `MAX_CONCURRENT` protects.
 */
class RunPool {
  private runs = new Map<string, Run>();

  private forUser(userId: string): Run {
    let run = this.runs.get(userId);
    if (!run) {
      run = new Run(userId);
      this.runs.set(userId, run);
    }
    return run;
  }

  /** Drops finished runs nobody is watching, so the map cannot grow forever. */
  private sweep(): void {
    for (const [userId, run] of this.runs) if (run.disposable) this.runs.delete(userId);
  }

  activeCount(): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.running) n++;
    return n;
  }

  /** True while any account is running — the machine-wide question. */
  anyRunning(): boolean {
    return this.activeCount() > 0;
  }

  stateFor(userId: string): RunState {
    return this.runs.get(userId)?.state ?? { ...IDLE_STATE, ownerUserId: null };
  }

  subscribe(userId: string, fn: (l: LogLine) => void): () => void {
    return this.forUser(userId).subscribe(fn);
  }

  backlog(userId: string, since = 0): LogLine[] {
    return this.runs.get(userId)?.backlog(since) ?? [];
  }

  private atCapacity(userId: string): string | null {
    if (this.runs.get(userId)?.running) return null; // its own guard reports better
    if (this.activeCount() < MAX_CONCURRENT) return null;
    return `The server is already running ${MAX_CONCURRENT} applications at once. Try again in a few minutes.`;
  }

  async start(
    mode: RunMode,
    overrides: Record<string, string>,
    userId: string,
    onApplicationSubmitted?: () => void | Promise<void>,
    onRehearsalCompleted?: () => void | Promise<void>,
  ): Promise<{ ok: boolean; error?: string }> {
    this.sweep();
    const full = this.atCapacity(userId);
    if (full) return { ok: false, error: full };
    return this.forUser(userId).start(mode, overrides, onApplicationSubmitted, onRehearsalCompleted);
  }

  async startQueue(userId: string, overrides: Record<string, string> = {}): Promise<{ ok: boolean; error?: string }> {
    this.sweep();
    const full = this.atCapacity(userId);
    if (full) return { ok: false, error: full };
    return this.forUser(userId).startQueue(overrides);
  }

  stop(userId: string): { ok: boolean; error?: string } {
    const run = this.runs.get(userId);
    if (!run) return { ok: false, error: 'Nothing is running.' };
    return run.stop();
  }
}

export const runner = new RunPool();

/** Reads seek-bot/.env into a plain object, skipping comments. */
export function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const SECRET_KEYS = new Set([
  'GEMINI_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  // Found while fixing the per-account data isolation bug: both were being
  // returned in full plaintext by /api/settings to any signed-in account.
  'GOOGLE_CLIENT_SECRET',
  'DATABASE_URL', // embeds the Postgres password
]);

/** Masks secrets — the dashboard should never render an API key. */
export function readEnvSafe(): Record<string, string> {
  const env = readEnv();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_KEYS.has(k) ? (v ? `set (${v.length} chars)` : '') : v;
  }
  return out;
}

/** Rewrites only the given keys, preserving comments and ordering. */
export function writeEnv(updates: Record<string, string>): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const remaining = { ...updates };

  const next = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const i = t.indexOf('=');
    if (i === -1) return line;
    const key = t.slice(0, i).trim();
    if (!(key in remaining)) return line;
    const value = remaining[key];
    delete remaining[key];
    return `${key}=${value}`;
  });

  for (const [k, v] of Object.entries(remaining)) next.push(`${k}=${v}`);
  writeFileSync(ENV_PATH, next.join('\n'));
}
