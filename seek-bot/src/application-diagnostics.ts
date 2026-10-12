import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'patchright';
import { config } from './config.js';
import { captchaDiagnosticSecrets, safeCaptchaDiagnostic } from './captcha/diagnostics.js';

interface FailureContext { stage: string; submitPressed?: boolean; lastTool?: string }
const captured = new WeakMap<object, FailureContext>();
export const applicationFailureContext = (error: unknown): FailureContext | undefined =>
  error && typeof error === 'object' ? captured.get(error) : undefined;

/** Synchronous evidence from the live objects, captured before any cleanup closes them. */
export function captureApplicationFailure(page: Page, jobId: string, error: unknown, context: FailureContext): void {
  if (applicationFailureContext(error)) return;
  if (error && typeof error === 'object') captured.set(error, context);
  try {
    const secrets = captchaDiagnosticSecrets(process.env);
    const probe = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
    const state = {
      pageClosed: probe(() => page.isClosed()), browserConnected: probe(() => page.context().browser()?.isConnected() ?? null),
      openPages: probe(() => page.context().pages().filter(p => !p.isClosed()).length),
      frameCount: probe(() => page.frames().length),
    };
    const stack = error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at /.test(line)).slice(0, 8)
      .map(line => safeCaptchaDiagnostic({ message: line }, secrets).message) : undefined;
    const report = { at: new Date().toISOString(), jobId, ...context, ...state, error: safeCaptchaDiagnostic(error, secrets), stack };
    console.log(`[application-failure] ${JSON.stringify(report)}`);
    const directory = resolve(config.dataDir, 'traces');
    mkdirSync(directory, { recursive: true });
    appendFileSync(resolve(directory, `${jobId.replace(/[^a-z0-9_-]/gi, '_')}.failures.jsonl`), JSON.stringify(report) + '\n', { mode: 0o600 });
  } catch { /* Logging must never replace the original application error. */ }
}
