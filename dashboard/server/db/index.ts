import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEnv } from '../runner.js';

/**
 * Postgres connection.
 *
 * The URL is read from seek-bot/.env (or the environment) at first use rather
 * than at import time, so the dashboard still starts — and can explain itself —
 * when the database is unreachable.
 */
let pool: pg.Pool | null = null;
let initError: string | null = null;

export function connectionString(): string {
  const env = readEnv();
  return (
    process.env.DATABASE_URL ??
    env.DATABASE_URL ??
    'postgresql://myasis:myasis_local_dev@localhost:5432/myasis'
  );
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString(),
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // A pool-level error would otherwise be an unhandled rejection and take
    // the dev server down with it.
    pool.on('error', (err) => {
      initError = err.message;
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export interface DbHealth {
  ok: boolean;
  version?: string;
  tables?: number;
  error?: string;
}

export async function health(): Promise<DbHealth> {
  try {
    const v = await one<{ version: string }>('select version()');
    const t = await one<{ n: string }>(
      "select count(*)::text as n from information_schema.tables where table_schema='public'",
    );
    return { ok: true, version: v?.version.split(',')[0], tables: Number(t?.n ?? 0) };
  } catch (e) {
    return { ok: false, error: initError ?? (e as Error).message };
  }
}

/** Applies schema.sql. Safe to re-run — every statement is IF NOT EXISTS. */
export async function migrate(): Promise<{ ok: boolean; error?: string }> {
  const file = resolve(import.meta.dirname, 'schema.sql');
  if (!existsSync(file)) return { ok: false, error: 'schema.sql not found' };
  try {
    await getPool().query(readFileSync(file, 'utf8'));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
