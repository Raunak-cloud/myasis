import { cpus, totalmem } from 'node:os';
import { humanizerEndpoint, probeHumanizer } from './humanizer-endpoint.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { exportUserForRun, syncRunResultsToDb } from './db/run-sync.js';
import { query } from './db/index.js';
import { userDir } from './userdata.js';

/** Saved run consoles kept per account; older ones are removed as new ones are written. */
const RUN_LOGS_KEPT = 60;

// `import.meta.dirname` — Vite's native config loader deprecates __dirname.
export const BOT_DIR = resolve(import.meta.dirname, '..', '..', 'seek-bot');
const ENV_PATH = resolve(BOT_DIR, '.env');

/** deploy/deploy.sh holds this while it rebuilds; a run launched then would load half-written code. */
const DEPLOY_LOCK = resolve(BOT_DIR, '..', '.deploying');
export function deploying(): boolean {
  return existsSync(DEPLOY_LOCK);
}
export const DEPLOYING_MESSAGE = 'Owtomate is installing an update. Try again in a minute.';

export type RunMode = 'search' | 'live';

/** Request bodies are untrusted: only these modes start a run. */
export function isRunMode(value: unknown): value is RunMode {
  return value === 'search' || value === 'live';
}

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

export interface KeywordRenewalContext {
  /** The normalized terms the child actually searched. */
  termsUsed: string;
  /** Exact database value at start, used for a conditional post-run save. */
  expectedSavedTerms: string;
}

const MAX_LINES = 2000;

/**
 * How many accounts may run at once.
 *
 * Each run drives a headed Chrome. Measured on the production box over six
 * real runs (September 2026, ten-minute averages): a run takes 0.3 to 0.5 of a
 * CPU core and adds 0.5 to 1.1 GB of memory, against an idle 0.1 of a core
 * and about 1 GB. On that machine — 2 cores, 8 GB — the CPU runs out first:
 * three runs average 45 to 75% of it, four reach 100%, and a saturated
 * machine shows up as slow pages, timeouts and failed bot checks rather than
 * as an error. So the limit is whichever of CPU and memory gives out first.
 *
 * MAX_CONCURRENT_RUNS overrides it. It is also the number of lanes the
 * scheduler spreads accounts across, so at most this many scheduled runs ever
 * start at the same moment.
 */
const CORES_PER_RUN = 0.6;
const GB_PER_RUN = 1.2;
const GB_RESERVED = 1.5; // the dashboard, Postgres, the display server and the OS

export function machineRunCapacity(cores = cpus().length, memoryGb = totalmem() / 1024 ** 3): number {
  return Math.max(1, Math.min(Math.floor(cores / CORES_PER_RUN), Math.floor((memoryGb - GB_RESERVED) / GB_PER_RUN)));
}

const configuredRuns = Number(process.env.MAX_CONCURRENT_RUNS);
export const MAX_CONCURRENT = Number.isInteger(configuredRuns) && configuredRuns >= 1 ? configuredRuns : machineRunCapacity();

const IDLE_STATE: RunState = {
  running: false,
  mode: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  applied: 0,
  ownerUserId: null,
};

function readQualifyingJobs(dataDir: string): number | null {
  const path = resolve(dataDir, 'run-summary.json');
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { qualifyingJobs?: unknown };
    return typeof value.qualifyingJobs === 'number' && Number.isInteger(value.qualifyingJobs) && value.qualifyingJobs >= 0
      ? value.qualifyingJobs
      : null;
  } catch {
    return null;
  }
}

export async function assertHumanizerHealthy(overrides: Record<string, string> = {}): Promise<void> {
  const fileEnv = readEnv();
  // A run whose plan does not include the humanizer never calls it, so its health is irrelevant.
  if (overrides.HUMANIZER_MODE === 'off') return;
  if ((overrides.HUMANIZER_REQUIRED ?? process.env.HUMANIZER_REQUIRED ?? fileEnv.HUMANIZER_REQUIRED) !== 'true') return;

  const endpoint = await humanizerEndpoint(overrides);
  if (!endpoint) throw new Error('The humanizer is required but HUMANIZER_URL is not configured. Set it in Admin → Config → Humanizer.');
  const { ready, detail } = await probeHumanizer(endpoint);
  if (!ready) throw new Error(`The humanizer is required but is not ready: ${detail}.`);
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
  private cdpPort: number | null = null;
  private onApplicationSubmitted: ((external: boolean) => void | Promise<void>) | null = null;
  /** Cleanup owned by the caller, such as returning a temporary free proxy. */
  private onFinished: (() => void | Promise<void>) | null = null;
  /** The run_starts row this run belongs to, when the caller made one. */
  private runStartId: string | null = null;
  /** Somebody pressed Stop. Such a run exits like a crash does, and must not be counted as one. */
  private stoppedByPerson = false;
  /** Keeps the account's next run out until result sync and keyword renewal finish. */
  private postProcessing = false;
  private keywordRenewal: KeywordRenewalContext | null = null;
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
      const submitted = raw.match(/✅ submitted(?: \[(external)\])?/);
      if (submitted) {
        this.state.applied++;
        if (this.onApplicationSubmitted) {
          void Promise.resolve(this.onApplicationSubmitted(submitted[1] === 'external')).catch((error) =>
            this.push('err', `Could not record application usage: ${(error as Error).message}`),
          );
        }
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

  get browserPort(): number | null {
    return this.cdpPort;
  }

  get occupiesSlot(): boolean {
    return this.state.running || this.cdpPort !== null || this.postProcessing;
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
    return !this.state.running && !this.postProcessing && this.state.finishedAt !== null && this.listeners.size === 0;
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
    cdpPort: number,
    onApplicationSubmitted?: (external: boolean) => void | Promise<void>,
    onFinished?: () => void | Promise<void>,
    runStartId?: string | null,
    keywordRenewal?: KeywordRenewalContext,
  ): Promise<{ ok: boolean; error?: string }> {
    const userId = this.userId;
    if (this.occupiesSlot) return { ok: false, error: 'A run is already in progress for this account.' };
    if (deploying()) return { ok: false, error: DEPLOYING_MESSAGE };
    if (!existsSync(resolve(BOT_DIR, 'dist', 'main.js'))) {
      return { ok: false, error: 'seek-bot is not built. Run `npm run build` in seek-bot first.' };
    }
    this.cdpPort = cdpPort;
    try {
      await assertHumanizerHealthy(overrides);
    } catch (error) {
      this.cdpPort = null;
      return { ok: false, error: (error as Error).message };
    }

    let dataDir: string;
    let profileOverrides: Record<string, string>;
    try {
      const exported = await exportUserForRun(userId);
      dataDir = exported.dir;
      profileOverrides = exported.overrides;
    } catch (error) {
      this.cdpPort = null;
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
      CDP_PORT: String(cdpPort),
      // Only a live run may submit; a search-only run never opens a form.
      DRY_RUN: mode === 'live' ? 'false' : 'true',
      // Always last: no override may point a run at another account's files.
      DATA_DIR: dataDir,
    };

    this.lines = [];
    this.seq = 0;
    this.onApplicationSubmitted = onApplicationSubmitted ?? null;
    this.onFinished = onFinished ?? null;
    this.runStartId = runStartId ?? null;
    this.keywordRenewal = keywordRenewal ?? null;
    this.stoppedByPerson = false;
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
    if (mode === 'live') this.push('sys', '  ⚠ LIVE: applications will be submitted');

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
  async startQueue(cdpPort: number, overrides: Record<string, string> = {}, runStartId?: string | null): Promise<{ ok: boolean; error?: string }> {
    const userId = this.userId;
    if (this.occupiesSlot) return { ok: false, error: 'A scan is already running for this account.' };
    if (deploying()) return { ok: false, error: DEPLOYING_MESSAGE };
    if (!existsSync(resolve(BOT_DIR, 'dist', 'queue.js'))) {
      return { ok: false, error: 'seek-bot is not built. Run `npm run build` in seek-bot first.' };
    }
    this.cdpPort = cdpPort;
    try {
      await assertHumanizerHealthy();
    } catch (error) {
      this.cdpPort = null;
      return { ok: false, error: (error as Error).message };
    }

    let dataDir: string;
    let profileOverrides: Record<string, string>;
    try {
      const exported = await exportUserForRun(userId);
      dataDir = exported.dir;
      profileOverrides = exported.overrides;
    } catch (error) {
      this.cdpPort = null;
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
      CDP_PORT: String(cdpPort),
      // Always last: no override may point a scan at another account's files.
      DATA_DIR: dataDir,
    };
    // Set only once the scan is really starting: a refused start must not overwrite the record of one in flight.
    this.runStartId = runStartId ?? null;
    this.keywordRenewal = null;
    this.stoppedByPerson = false;
    this.spawnChild(spawn(process.execPath, ['dist/queue.js'], { cwd: BOT_DIR, env }), userId, dataDir, 'scan');
    return { ok: true };
  }

  /** Wiring shared by a run and a scan: console piping, exit handling, result sync. */
  private spawnChild(child: ChildProcess, userId: string, dataDir: string, kind: 'run' | 'scan'): void {
    this.child = child;
    child.stdout?.on('data', (b) => this.push('out', b.toString()));
    child.stderr?.on('data', (b) => this.push('err', b.toString()));
    child.on('error', (e) => this.push('err', `spawn failed: ${e.message}`));
    child.on('close', (code) => void this.finishChild(userId, dataDir, kind, code));
  }

  private async finishChild(userId: string, dataDir: string, kind: 'run' | 'scan', code: number | null): Promise<void> {
    this.state.running = false;
    this.state.exitCode = code;
    this.state.finishedAt = new Date().toISOString();
    this.child = null;
    this.cdpPort = null;
    this.onApplicationSubmitted = null;
    const onFinished = this.onFinished;
    this.onFinished = null;
    this.postProcessing = true;
    const renewal = this.keywordRenewal;
    this.keywordRenewal = null;
    this.push('sys', `■ ${kind} finished (exit ${code})`);

    const postRunTasks: Array<Promise<void>> = [
      // Fold what this run actually did — new applications, run events — back
      // into userId's Postgres rows. The sync is idempotent, so retries cannot
      // double-count an application or event.
      syncRunResultsToDb(userId, dataDir)
        .then((r) => this.push('sys', `  synced ${r.applications} application(s), ${r.runEvents} event(s) to your account`))
        .catch((error) => this.push('err', `Could not save this ${kind}'s results: ${(error as Error).message}`)),
    ];
    if (onFinished) {
      postRunTasks.push(
        Promise.resolve()
          .then(onFinished)
          .catch((error) => this.push('err', `Could not clean up after this ${kind}: ${(error as Error).message}`)),
      );
    }

    const qualifyingJobs = kind === 'run' && code === 0 ? readQualifyingJobs(dataDir) : null;
    if (renewal && qualifyingJobs !== null && qualifyingJobs < 2) {
      postRunTasks.push(
        import('./search-terms.js')
          .then(({ renewSearchTermsAfterSparseRun }) => (
            renewSearchTermsAfterSparseRun(userId, renewal.termsUsed, renewal.expectedSavedTerms)
          ))
          .then((result) => {
            if (result.status === 'renewed') {
              this.push('sys', `  ↻ Search terms renewed for the next run: ${result.terms.join(', ')}`);
            } else if (result.status === 'user-changed') {
              this.push('sys', '  Search terms were not auto-renewed because you changed them during the run.');
            } else {
              this.push('err', `Could not auto-renew search terms: ${result.error}`);
            }
          })
          .catch((error) => this.push('err', `Could not auto-renew search terms: ${(error as Error).message}`)),
      );
    }

    try {
      // Keep this account out of another run until its next-run settings and
      // result records are durable.
      await Promise.all(postRunTasks);
      await this.recordFinish(userId, code);
    } catch (error) {
      this.push('err', `Could not save this ${kind}'s record: ${(error as Error).message}`);
    } finally {
      this.postProcessing = false;
    }
  }

  /**
   * How the run ended, onto its record, with its console saved beside the
   * account's data so it can be read after the dashboard restarts.
   */
  private async recordFinish(userId: string, code: number | null): Promise<void> {
    const runStartId = this.runStartId;
    this.runStartId = null;
    if (!runStartId) return;
    const dir = resolve(userDir(userId), 'run-logs');
    mkdirSync(dir, { recursive: true });
    const file = `${runStartId}.jsonl`;
    writeFileSync(resolve(dir, file), this.lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const saved = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]));
    for (const old of saved.slice(RUN_LOGS_KEPT)) rmSync(resolve(dir, old), { force: true });
    await query(
      'UPDATE run_starts SET finished_at = now(), exit_code = $2, applied = $3, log_file = $4, stopped = $5 WHERE id = $1',
      [runStartId, code, this.state.applied, file, this.stoppedByPerson],
    );
  }

  stop(): { ok: boolean; error?: string } {
    if (!this.child) return { ok: false, error: 'Nothing is running.' };
    this.stoppedByPerson = true;
    this.push('sys', '⏹ stop requested, terminating');
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

  /**
   * Every run asked to stop, for a dashboard that is shutting down. The bot
   * closes its browser on SIGTERM; a run killed outright leaves Chrome
   * holding the account's profile and every later run failing on it.
   */
  stopAll(): void {
    for (const run of this.runs.values()) {
      if (run.state.running) run.stop();
    }
  }

  activeCount(): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.occupiesSlot) n++;
    return n;
  }

  /** Accounts whose run still owns machine resources, used by lease cleanup. */
  activeUserIds(): string[] {
    return [...this.runs.entries()].filter(([, run]) => run.occupiesSlot).map(([userId]) => userId);
  }

  /** True while any account is running — the machine-wide question. */
  anyRunning(): boolean {
    return this.activeCount() > 0;
  }

  stateFor(userId: string): RunState {
    return this.runs.get(userId)?.state ?? { ...IDLE_STATE, ownerUserId: null };
  }

  browserPortFor(userId: string): number | null {
    return this.runs.get(userId)?.browserPort ?? null;
  }

  private availableBrowserPort(): number {
    const env = readEnv();
    const first = Number(process.env.CDP_PORT ?? env.CDP_PORT ?? 9333);
    const used = new Set([...this.runs.values()].map((run) => run.browserPort).filter((port) => port !== null));
    for (let offset = 0; offset < MAX_CONCURRENT; offset++) {
      const candidate = first + offset;
      if (!used.has(candidate)) return candidate;
    }
    throw new Error('No browser viewer slot is available.');
  }

  subscribe(userId: string, fn: (l: LogLine) => void): () => void {
    return this.forUser(userId).subscribe(fn);
  }

  backlog(userId: string, since = 0): LogLine[] {
    return this.runs.get(userId)?.backlog(since) ?? [];
  }

  private atCapacity(userId: string): string | null {
    if (this.runs.get(userId)?.occupiesSlot) return null; // its own guard reports better
    if (this.activeCount() < MAX_CONCURRENT) return null;
    return `The server is already running ${MAX_CONCURRENT} applications at once. Try again in a few minutes.`;
  }

  async start(
    mode: RunMode,
    overrides: Record<string, string>,
    userId: string,
    onApplicationSubmitted?: (external: boolean) => void | Promise<void>,
    onFinished?: () => void | Promise<void>,
    runStartId?: string | null,
    keywordRenewal?: KeywordRenewalContext,
  ): Promise<{ ok: boolean; error?: string }> {
    this.sweep();
    const full = this.atCapacity(userId);
    if (full) return { ok: false, error: full };
    return this.forUser(userId).start(
      mode,
      overrides,
      this.availableBrowserPort(),
      onApplicationSubmitted,
      onFinished,
      runStartId,
      keywordRenewal,
    );
  }

  async startQueue(userId: string, overrides: Record<string, string> = {}, runStartId?: string | null): Promise<{ ok: boolean; error?: string }> {
    this.sweep();
    const full = this.atCapacity(userId);
    if (full) return { ok: false, error: full };
    return this.forUser(userId).startQueue(this.availableBrowserPort(), overrides, runStartId);
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
  'SITE_AUTH_SECRET',
  'DATABASE_URL', // embeds the Postgres password
  // Posts conversions to the ad account. REDDIT_PIXEL_ID is deliberately not
  // here: it ships to every browser anyway, and the settings panel should show it.
  'REDDIT_CONVERSION_TOKEN',
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
  const written = new Set<string>();

  /**
   * Every line for a key is rewritten, not just the first. `readEnv` keeps the
   * last value it sees, so a key listed twice — the server's ADMIN_EMAILS is —
   * would otherwise take the update on its first line and go on reading the
   * old value from its second.
   */
  const next = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const i = t.indexOf('=');
    if (i === -1) return line;
    const key = t.slice(0, i).trim();
    if (!(key in updates)) return line;
    written.add(key);
    return `${key}=${updates[key]}`;
  });

  /**
   * A file that ended in a newline splits into a trailing empty string. New
   * keys used to be pushed after it, so the join put a blank line before them
   * and no newline after — and the next `printf >> .env` by hand glued its key
   * onto the end of the last value. Trim the trailing blanks, append, and
   * always finish with a newline: the file is the one thing here that other
   * tools also write.
   */
  while (next.length && next[next.length - 1].trim() === '') next.pop();
  for (const [k, v] of Object.entries(updates)) if (!written.has(k)) next.push(`${k}=${v}`);
  writeFileSync(ENV_PATH, `${next.join('\n')}\n`);
}
