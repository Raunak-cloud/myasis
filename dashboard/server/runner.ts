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

interface RunState {
  running: boolean;
  mode: RunMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  applied: number;
  /**
   * Which account's run this is. Only one run can be active at a time (one
   * shared Chrome/SEEK session, machine-wide), but its live status/console —
   * and the finished-run summary that lingers after — must still only be
   * visible to, and stoppable by, that account, not whichever account
   * happens to have the Apply tab open. Stays set after the run finishes
   * (until the next run overwrites it) so the "last run" summary stays
   * scoped too, not just the live stream.
   */
  ownerUserId: string | null;
}

const MAX_LINES = 2000;

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

class Runner {
  private child: ChildProcess | null = null;
  private onApplicationSubmitted: (() => void | Promise<void>) | null = null;
  private onRehearsalCompleted: (() => void | Promise<void>) | null = null;
  private lines: LogLine[] = [];
  private seq = 0;
  private listeners = new Set<(l: LogLine) => void>();
  state: RunState = {
    running: false,
    mode: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    applied: 0,
    ownerUserId: null,
  };

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
    userId: string,
    onApplicationSubmitted?: () => void | Promise<void>,
    onRehearsalCompleted?: () => void | Promise<void>,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.state.running) return { ok: false, error: 'A run is already in progress.' };
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
      // (whose profile.txt, whose experience/skills) and must never be
      // settable by a caller-supplied override.
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

    this.child = spawn(process.execPath, args, { cwd: BOT_DIR, env });
    this.child.stdout?.on('data', (b) => this.push('out', b.toString()));
    this.child.stderr?.on('data', (b) => this.push('err', b.toString()));
    this.child.on('error', (e) => this.push('err', `spawn failed: ${e.message}`));
    this.child.on('close', (code) => {
      this.state.running = false;
      this.state.exitCode = code;
      this.state.finishedAt = new Date().toISOString();
      this.child = null;
      this.onApplicationSubmitted = null;
      this.onRehearsalCompleted = null;
      this.push('sys', `■ run finished (exit ${code})`);
      // Fold what this run actually did — new applications, run events — back
      // into userId's Postgres rows. `syncRunResultsToDb` is idempotent (ON
      // CONFLICT DO NOTHING on natural keys), so this can never double-count
      // even if it were somehow triggered twice for the same run.
      void syncRunResultsToDb(userId, dataDir)
        .then((r) => this.push('sys', `  synced ${r.applications} application(s), ${r.runEvents} event(s) to your account`))
        .catch((error) => this.push('err', `Could not save this run's results: ${(error as Error).message}`));
    });

    return { ok: true };
  }

  /**
   * Runs the queue builder — discovery, scoring and drafting only. It opens no
   * application form, so unlike `start()` there is nothing here that needs a
   * confirmation gate. Same per-account export/sync as `start()` — the scan
   * still reads this account's résumés/knowledge/applied-jobs history to
   * dedupe and draft, off `DATA_DIR`, not the shared folder.
   */
  async startQueue(
    userId: string,
    overrides: Record<string, string> = {},
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.state.running) return { ok: false, error: 'A scan is already running.' };
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
    this.child = spawn(process.execPath, ['dist/queue.js'], { cwd: BOT_DIR, env });
    this.child.stdout?.on('data', (b) => this.push('out', b.toString()));
    this.child.stderr?.on('data', (b) => this.push('err', b.toString()));
    this.child.on('close', (code) => {
      this.state.running = false;
      this.state.exitCode = code;
      this.state.finishedAt = new Date().toISOString();
      this.child = null;
      this.push('sys', `■ scan finished (exit ${code})`);
      void syncRunResultsToDb(userId, dataDir)
        .then((r) => this.push('sys', `  synced ${r.applications} application(s), ${r.runEvents} event(s) to your account`))
        .catch((error) => this.push('err', `Could not save this scan's results: ${(error as Error).message}`));
    });
    return { ok: true };
  }

  stop(userId: string): { ok: boolean; error?: string } {
    if (!this.child) return { ok: false, error: 'Nothing is running.' };
    if (this.state.ownerUserId !== userId) {
      return { ok: false, error: 'This run belongs to another account.' };
    }
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

export const runner = new Runner();

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
