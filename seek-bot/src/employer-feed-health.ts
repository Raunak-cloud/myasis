import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Public endpoint availability only. Never a fit decision or a cached job response. */
export class EmployerFeedHealth {
  private failures = new Map<string, { until: number; reason: string }>();
  constructor(private directory?: string, private now = Date.now) {}
  private file(target: string) { return resolve(this.directory!, createHash('sha256').update(target).digest('hex') + '.json'); }
  async unavailable(target: string): Promise<string | undefined> {
    let state = this.failures.get(target);
    if (!state && this.directory) {
      try { state = JSON.parse(await readFile(this.file(target), 'utf8')); } catch { /* A missing health record never blocks a source. */ }
    }
    if (state && Number.isFinite(state.until) && state.until > this.now() && state.until <= this.now() + 86400_000) {
      this.failures.set(target, state); return state.reason;
    }
    this.failures.delete(target); return undefined;
  }
  async failed(target: string, reason: string, delay: number): Promise<void> {
    const state = { until: this.now() + Math.min(86400_000, Math.max(0, delay)), reason: reason.slice(0, 500) };
    this.failures.set(target, state);
    if (!this.directory) return;
    const file = this.file(target), temp = file + '.' + randomUUID() + '.tmp';
    try { await mkdir(this.directory, { recursive: true }); await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, file); }
    catch { /* Availability caching cannot invalidate other public results. */ }
    finally { await unlink(temp).catch(() => {}); }
  }
  async healthy(target: string): Promise<void> {
    this.failures.delete(target);
    if (this.directory) await unlink(this.file(target)).catch(() => {});
  }
}
