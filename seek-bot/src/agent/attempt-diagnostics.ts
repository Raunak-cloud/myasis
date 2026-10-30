import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { applicationModelEnvironment, withApplicationModel } from '../application-model.js';
import { captchaDiagnosticSecrets, safeCaptchaDiagnostic } from '../captcha/diagnostics.js';

interface AttemptIdentity {
  attemptId: string; runStartId?: string; jobId: string; title: string; company: string;
  startedAt: string; mode: string;
}
const scope = new AsyncLocalStorage<AttemptIdentity>();
const workerId = randomUUID();
export const currentAttempt = () => scope.getStore();
/** Browser event emitters may originate outside the application async chain. */
export function bindAttemptCallback<T extends (...args: any[]) => any>(callback: T): T {
  const identity = currentAttempt();
  const env = applicationModelEnvironment();
  return (identity ? (...args: Parameters<T>) => withApplicationModel(env, () => scope.run(identity, () => callback(...args))) : callback) as T;
}
const diagnosticRunId = () => /^\d+$/.test(applicationModelEnvironment().OWTOMATE_RUN_START_ID ?? '') ? applicationModelEnvironment().OWTOMATE_RUN_START_ID : undefined;

export function recordDiagnostic(input: {
  severity: 'info' | 'warning' | 'error'; category: string; stage: string;
  message: string; error?: unknown; step?: number; tool?: string; batchIndex?: number;
  disposition?: string; outcome?: string; retry?: number;
}): void {
  try {
    const { error, message, ...fields } = input;
    const secrets = captchaDiagnosticSecrets(applicationModelEnvironment());
    const clean = (text: string) => String(safeCaptchaDiagnostic(text, secrets).message ?? '');
    const identity = currentAttempt();
    const event = { id: randomUUID(), at: new Date().toISOString(), runStartId: diagnosticRunId(), ...identity,
      ...fields, message: clean(message), error: error ? safeCaptchaDiagnostic(error, secrets) : undefined,
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 9).map(clean) : undefined };
    const dir = resolve(config.dataDir, 'traces');
    mkdirSync(dir, { recursive: true });
    const file = `run-${event.runStartId ?? `unassigned-${workerId}`}.diagnostics.jsonl`;
    appendFileSync(resolve(dir, file), JSON.stringify(event) + '\n', { mode: 0o600 });
    // Also survives through the existing run console and its saved log.
    console.log(`[run-diagnostic] ${JSON.stringify(event)}`);
  } catch {
    console.warn('[diagnostics-unavailable] Could not persist application diagnostics. Application execution continues.');
  }
}

/** Separate identity for preparation, confirmation and every retry. Never changes execution. */
export async function withApplicationAttempt<T extends { outcome: { status: string; reason?: string } }>(
  job: { id: string; title: string; company: string }, operation: () => Promise<T>,
): Promise<T> {
  const identity: AttemptIdentity = { attemptId: randomUUID(), runStartId: diagnosticRunId(), jobId: job.id,
    title: job.title, company: job.company, startedAt: new Date().toISOString(),
    mode: applicationModelEnvironment().APPLICATION_REVIEW_MODE || 'auto' };
  return scope.run(identity, async () => {
    recordDiagnostic({ severity: 'info', category: 'attempt_started', stage: 'application', message: 'Application attempt started.' });
    try {
      const result = await operation();
      if (result.outcome.status === 'skipped' && /budget|allowance|infrastructure|browser.*closed|time.*limit|technical|error|fail(?:ed|ure)|disconnect/i.test(result.outcome.reason ?? '')) {
        recordDiagnostic({ severity: 'warning', category: 'application_stopped', stage: 'application', message: result.outcome.reason! });
      }
      recordDiagnostic({ severity: 'info', category: 'attempt_finished', stage: 'application',
        message: 'Application attempt finished.', outcome: result.outcome.status });
      return result;
    } catch (error) {
      recordDiagnostic({ severity: 'error', category: 'application_exception', stage: 'application',
        message: error instanceof Error ? error.message : String(error), error });
      throw error;
    }
  });
}

/** Use structured dispositions and batch entries, including stale refs that are not thrown. */
export function recordToolDiagnostic(step: number, tool: string, message: string, disposition?: string, error?: unknown): void {
  let entries: Array<{ index?: number; error?: string; kind?: string; message?: string }> = [];
  try { const body = JSON.parse(message); if (Array.isArray(body.results)) entries = body.results; } catch { /* Plain tool response. */ }
  const failed = entries.filter(entry => entry.error || entry.kind === 'error' || entry.kind === 'failed');
  for (const entry of entries) {
    const warning = entry.message?.match(/(?:The browser action completed, but its follow-up wait|The requested wait) (?:timed out|could not be evaluated)[\s\S]*/)?.[0];
    if (warning) recordDiagnostic({ severity: 'warning', category: 'wait_warning', stage: 'tool', step, tool, batchIndex: entry.index, message: warning });
  }
  if (failed.length) {
    for (const entry of failed) recordDiagnostic({ severity: 'warning', category: 'tool_error', stage: 'tool', step, tool,
      batchIndex: entry.index, disposition: 'failed', message: String(entry.error || entry.message || 'Batch action failed.') });
  } else if (disposition === 'failed' || /^Observed ref .*no longer on the page|^Browser\/tool error:/.test(message)) {
    recordDiagnostic({ severity: 'warning', category: /^Observed ref .*no longer on the page/.test(message) ? 'stale_target' : 'tool_error', stage: 'tool', step, tool,
      disposition, error, message: message.split('FRESH FAILURE EVIDENCE')[0] });
  } else if (!entries.length && /follow-up wait (?:timed out|could not be evaluated)|The requested wait (?:timed out|could not be evaluated)/.test(message)) {
    recordDiagnostic({ severity: 'warning', category: 'wait_warning', stage: 'tool', step, tool,
      message: message.split('FRESH FAILURE EVIDENCE')[0] });
  } else if (disposition === 'reobserve') {
    recordDiagnostic({ severity: 'info', category: 'tool_handoff', stage: 'tool', step, tool, disposition,
      message: 'Tool requested a fresh observation or normal confirmation checkpoint. See the recorded step for its response.' });
  }
}
