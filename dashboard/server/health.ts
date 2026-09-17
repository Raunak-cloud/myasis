import { open, readdir, readFile, stat, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { resolve } from 'node:path';
import { one } from './db/index.js';
import { readEnv, runner, MAX_CONCURRENT, BOT_DIR } from './runner.js';
import { TRACE_RETENTION_DAYS } from './trace-retention.js';
import { USERS_DIR } from './userdata.js';

/**
 * What the owner of this machine needs to see on one screen.
 *
 * Everything here is read from the machine itself — /proc, the filesystem,
 * the database — rather than from a monitoring service, because the whole
 * product runs on one box and the questions worth answering are simple: is it
 * running out of disk, is it running out of memory, is anything down, and
 * what has it been saying.
 *
 * The cheap readings are taken per request. Directory sizes are not: walking
 * every account's data takes seconds, so it is measured on a timer and served
 * from the last result.
 */

export interface StorageBreakdown {
  databaseMb: number;
  userDataMb: number;
  chromeMb: number;
  tracesMb: number;
  otherMb: number;
  /** Largest accounts first; the ones worth knowing about. */
  perUser: Array<{ userId: string; totalMb: number; chromeMb: number; tracesMb: number }>;
  measuredAt: string | null;
  measuring: boolean;
}

export interface ServerHealth {
  at: string;
  hostUptimeSeconds: number;
  processUptimeSeconds: number;
  cpu: { cores: number; loadAverage: number[]; busyPercent: number | null };
  memory: { totalMb: number; usedMb: number; availableMb: number; percent: number };
  swap: { totalMb: number; usedMb: number; percent: number };
  disk: { totalGb: number; usedGb: number; freeGb: number; percent: number };
  storage: StorageBreakdown;
  runs: { active: number; capacity: number };
  traceRetentionDays: number;
  services: Array<{ name: string; ok: boolean; detail: string }>;
  topProcesses: Array<{ pid: number; name: string; rssMb: number }>;
}

const MB = 1024 * 1024;
const round = (value: number, places = 1): number => Number(value.toFixed(places));

// ---------------------------------------------------------------- cpu

/**
 * Busy percentage needs two readings, so the first request after a restart
 * reports null rather than a number invented from a single sample.
 */
let previousCpu: { total: number; idle: number } | null = null;

async function cpuBusyPercent(): Promise<number | null> {
  try {
    const line = (await readFile('/proc/stat', 'utf8')).split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const total = parts.reduce((sum, value) => sum + value, 0);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const last = previousCpu;
    previousCpu = { total, idle };
    if (!last || total <= last.total) return null;
    const busy = 1 - (idle - last.idle) / (total - last.total);
    return round(Math.max(0, Math.min(1, busy)) * 100);
  } catch {
    return null;
  }
}

async function meminfo(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    for (const line of (await readFile('/proc/meminfo', 'utf8')).split('\n')) {
      const match = line.match(/^(\w+):\s+(\d+) kB$/);
      if (match) out[match[1]] = Number(match[2]) / 1024;
    }
  } catch {
    // Not Linux, or /proc unreadable; the caller reports zeros.
  }
  return out;
}

async function hostUptime(): Promise<number> {
  try {
    return Math.round(Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]));
  } catch {
    return 0;
  }
}

async function loadAverage(): Promise<number[]> {
  try {
    return (await readFile('/proc/loadavg', 'utf8')).split(' ').slice(0, 3).map(Number);
  } catch {
    return [0, 0, 0];
  }
}

/** The heaviest processes by resident memory, which is what fills this box. */
async function topProcesses(limit = 6): Promise<Array<{ pid: number; name: string; rssMb: number }>> {
  const rows: Array<{ pid: number; name: string; rssMb: number }> = [];
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return rows;
  }
  const byName = new Map<string, { pid: number; name: string; rssMb: number }>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = await readFile(`/proc/${entry}/status`, 'utf8');
      const name = status.match(/^Name:\s+(.+)$/m)?.[1] ?? 'unknown';
      const rssKb = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0);
      if (!rssKb) continue;
      // Chrome is dozens of processes; one line for the family is what is useful.
      const family = /chrome|chromium/i.test(name) ? 'chrome' : name;
      const existing = byName.get(family);
      if (existing) existing.rssMb += rssKb / 1024;
      else byName.set(family, { pid: Number(entry), name: family, rssMb: rssKb / 1024 });
    } catch {
      // The process exited while being read; skip it.
    }
  }
  for (const row of byName.values()) rows.push({ ...row, rssMb: round(row.rssMb, 0) });
  return rows.sort((a, b) => b.rssMb - a.rssMb).slice(0, limit);
}

// ---------------------------------------------------------------- storage

async function directorySize(path: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        try {
          total += (await stat(child)).size;
        } catch {
          // Vanished mid-walk.
        }
      }
    }
  };
  await walk(path);
  return total;
}

let storage: StorageBreakdown = {
  databaseMb: 0, userDataMb: 0, chromeMb: 0, tracesMb: 0, otherMb: 0,
  perUser: [], measuredAt: null, measuring: false,
};

/**
 * Walking every account's data costs seconds, so it runs on a timer and the
 * dashboard reads whatever the last pass found. Sizes on this scale do not
 * change meaningfully between one minute and the next.
 */
export async function measureStorage(): Promise<void> {
  if (storage.measuring) return;
  storage = { ...storage, measuring: true };
  try {
    const databaseBytes = Number(
      (await one<{ size: string }>('SELECT pg_database_size(current_database())::text AS size').catch(() => null))?.size ?? 0,
    );

    const perUser: StorageBreakdown['perUser'] = [];
    let chrome = 0;
    let traces = 0;
    let userData = 0;
    let accounts: string[] = [];
    try {
      accounts = (await readdir(USERS_DIR, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      accounts = [];
    }
    for (const userId of accounts) {
      const base = resolve(USERS_DIR, userId);
      const total = await directorySize(base);
      const chromeBytes = await directorySize(resolve(base, 'chrome'));
      const traceBytes = await directorySize(resolve(base, 'traces'));
      userData += total;
      chrome += chromeBytes;
      traces += traceBytes;
      perUser.push({
        userId,
        totalMb: round(total / MB, 0),
        chromeMb: round(chromeBytes / MB, 0),
        tracesMb: round(traceBytes / MB, 0),
      });
    }

    storage = {
      databaseMb: round(databaseBytes / MB, 0),
      userDataMb: round(userData / MB, 0),
      chromeMb: round(chrome / MB, 0),
      tracesMb: round(traces / MB, 0),
      otherMb: round(Math.max(0, userData - chrome - traces) / MB, 0),
      perUser: perUser.sort((a, b) => b.totalMb - a.totalMb).slice(0, 20),
      measuredAt: new Date().toISOString(),
      measuring: false,
    };
  } catch {
    storage = { ...storage, measuring: false };
  }
}

let storageTimer: NodeJS.Timeout | null = null;

export function startHealthMaintenance(): void {
  if (storageTimer) return;
  setTimeout(() => void measureStorage(), 20_000).unref();
  storageTimer = setInterval(() => void measureStorage(), 30 * 60_000);
  storageTimer.unref();
}

// ---------------------------------------------------------------- services

async function reachable(url: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function serviceChecks(): Promise<ServerHealth['services']> {
  const env = readEnv();
  const checks: ServerHealth['services'] = [];

  const database = await one<{ ok: number }>('SELECT 1 AS ok').then(() => true).catch(() => false);
  checks.push({ name: 'Database', ok: database, detail: database ? 'answering' : 'not answering' });

  const humanizerUrl = (process.env.HUMANIZER_URL ?? env.HUMANIZER_URL ?? '').replace(/\/$/, '');
  const fallbackUrl = (process.env.HUMANIZER_FALLBACK_URL ?? env.HUMANIZER_FALLBACK_URL ?? '').replace(/\/$/, '');
  if (humanizerUrl || fallbackUrl) {
    const primary = humanizerUrl ? await reachable(`${humanizerUrl}/health`) : false;
    const fallback = !primary && fallbackUrl ? await reachable(`${fallbackUrl}/health`) : false;
    checks.push({
      name: 'Humanizer',
      ok: primary || fallback,
      detail: primary ? `answering on ${humanizerUrl}` : fallback ? `primary down, using ${fallbackUrl}` : 'not answering',
    });
  }

  const stripeConfigured = Boolean((process.env.STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY ?? '').trim());
  checks.push({
    name: 'Payments',
    ok: stripeConfigured,
    detail: stripeConfigured ? 'Stripe keys present' : 'Stripe keys not set — checkout is disabled',
  });

  const geoip = (process.env.GEOIP_DB ?? env.GEOIP_DB ?? '').trim();
  checks.push({
    name: 'Visitor locations',
    ok: Boolean(geoip) && existsSync(geoip),
    detail: !geoip ? 'GEOIP_DB not set' : existsSync(geoip) ? 'database installed' : 'file missing',
  });

  return checks;
}

// ---------------------------------------------------------------- logs

/**
 * The server's own console, as pm2 records it.
 *
 * Both streams are read and merged so a failure and the work around it appear
 * in one list. Only the tail is read: these files reach hundreds of megabytes
 * and nobody scrolls that far.
 */
export interface LogLine {
  stream: 'out' | 'error';
  text: string;
}

function logPaths(): { out: string; error: string } {
  const dir = process.env.PM2_LOG_DIR ?? resolve(homedir(), '.pm2', 'logs');
  const name = process.env.PM2_APP_NAME ?? 'myasis-dashboard';
  return { out: resolve(dir, `${name}-out-0.log`), error: resolve(dir, `${name}-error-0.log`) };
}

async function tail(path: string, lines: number): Promise<string[]> {
  try {
    const { size } = await stat(path);
    // Enough bytes to hold the wanted lines without reading a huge file.
    const want = Math.min(size, lines * 400);
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(want);
      await handle.read(buffer, 0, want, Math.max(0, size - want));
      return buffer.toString('utf8').split('\n').filter(Boolean).slice(-lines);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

export async function readServerLogs(lines = 200): Promise<LogLine[]> {
  const { out, error } = logPaths();
  const [outLines, errorLines] = await Promise.all([tail(out, lines), tail(error, lines)]);
  const merged: LogLine[] = [
    ...outLines.map((text) => ({ stream: 'out' as const, text })),
    ...errorLines.map((text) => ({ stream: 'error' as const, text })),
  ];
  /**
   * pm2 prefixes each line with an ISO timestamp, so sorting on the raw text
   * puts the two streams in real order. Lines without one (a stack trace's
   * continuation) keep their place behind the line they belong to.
   */
  return merged
    .map((line, index) => ({ line, index, at: line.text.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+/)?.[0] ?? '' }))
    .sort((a, b) => (a.at && b.at ? a.at.localeCompare(b.at) || a.index - b.index : a.index - b.index))
    .map((entry) => entry.line)
    .slice(-lines);
}

// ---------------------------------------------------------------- the report

export async function serverHealth(): Promise<ServerHealth> {
  const [busyPercent, mem, uptime, load, processes, services] = await Promise.all([
    cpuBusyPercent(),
    meminfo(),
    hostUptime(),
    loadAverage(),
    topProcesses(),
    serviceChecks(),
  ]);

  let disk = { totalGb: 0, usedGb: 0, freeGb: 0, percent: 0 };
  try {
    const fs = await statfs(BOT_DIR);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    const used = total - fs.bfree * fs.bsize;
    disk = {
      totalGb: round(total / 1024 ** 3),
      usedGb: round(used / 1024 ** 3),
      freeGb: round(free / 1024 ** 3),
      percent: total ? round((used / total) * 100) : 0,
    };
  } catch {
    // Reported as zeros rather than failing the whole panel.
  }

  const total = mem.MemTotal ?? 0;
  const available = mem.MemAvailable ?? 0;
  const swapTotal = mem.SwapTotal ?? 0;
  const swapUsed = swapTotal - (mem.SwapFree ?? 0);

  return {
    at: new Date().toISOString(),
    hostUptimeSeconds: uptime,
    processUptimeSeconds: Math.round(process.uptime()),
    cpu: { cores: cpus().length, loadAverage: load, busyPercent },
    memory: {
      totalMb: round(total, 0),
      usedMb: round(total - available, 0),
      availableMb: round(available, 0),
      percent: total ? round(((total - available) / total) * 100) : 0,
    },
    swap: { totalMb: round(swapTotal, 0), usedMb: round(swapUsed, 0), percent: swapTotal ? round((swapUsed / swapTotal) * 100) : 0 },
    disk,
    storage,
    runs: { active: runner.activeCount(), capacity: MAX_CONCURRENT },
    traceRetentionDays: TRACE_RETENTION_DAYS,
    services,
    topProcesses: processes,
  };
}
