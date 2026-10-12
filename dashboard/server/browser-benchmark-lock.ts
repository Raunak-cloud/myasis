import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userDir } from './userdata.js';

/** The diagnostic owns this profile too; a stale file from an exited operator does not. */
export function browserBenchmarkInProgress(userId: string): boolean {
  try {
    const lease = JSON.parse(readFileSync(resolve(userDir(userId), 'browser-benchmark.lock'), 'utf8'));
    if (!Number.isInteger(lease.pid) || lease.pid < 1) return false;
    process.kill(lease.pid, 0);
    return true;
  } catch { return false; }
}
