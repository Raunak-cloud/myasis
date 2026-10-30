import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeCaptchaDiagnostic } from '../../seek-bot/src/captcha/diagnostics.js';
import type { RunDiagnostics, RunIssue, RunAttempt } from '../src/run-diagnostics.js';
import { TRACE_RETENTION_DAYS } from './trace-retention.js';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function records(file: string): Record<string, any>[] {
  if (!existsSync(file) || !lstatSync(file).isFile()) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? [value] : []; } catch { return []; } // A currently appended line may be incomplete.
  });
}
export function readRunDiagnostics(runId: string, directory: string,
  lines: Array<{ stream: string; text: string; ts: string }>,
): RunDiagnostics {
  if (!/^\d+$/.test(runId)) throw new Error('Invalid run identifier.');
  const events = records(resolve(directory, 'traces', `run-${runId}.diagnostics.jsonl`));
  for (const line of lines) {
    const marker = line.text.indexOf('[run-diagnostic] ');
    if (marker >= 0) try { events.push(JSON.parse(line.text.slice(marker + 17))); } catch { /* Partial console chunk. */ }
  }
  const unique = [...new Map(events.filter(e => e && typeof e.id === 'string' && typeof e.at === 'string'
    && typeof e.message === 'string' && String(e.runStartId) === runId).map(e => [e.id, e])).values()];
  const attempts = new Map<string, RunAttempt>();
  const issues: RunIssue[] = [];
  for (const event of unique) {
    if (typeof event.attemptId === 'string' && uuid.test(event.attemptId)) {
      const entry: RunAttempt = attempts.get(event.attemptId) ?? { attemptId: event.attemptId, jobId: event.jobId,
        title: event.title, company: event.company, startedAt: event.startedAt, mode: event.mode };
      if (event.outcome) entry.outcome = event.outcome;
      if (event.category === 'application_exception') entry.outcome = 'interrupted';
      attempts.set(entry.attemptId, entry);
    }
    if (event.severity !== 'info') issues.push({ id: event.id, at: event.at, severity: event.severity,
      category: event.category, stage: event.stage, message: event.message, attemptId: event.attemptId,
      jobId: event.jobId, title: event.title, tool: event.tool, step: event.step, batchIndex: event.batchIndex,
      disposition: event.disposition, stack: event.stack });
  }
  // Startup, search, matcher, process, cleanup and persistence errors already use the run console.
  // Retain those alongside structured tool errors, including historical runs.
  for (const [index, line] of lines.entries()) {
    if (line.text.includes('[run-diagnostic] ')) continue;
    if (line.stream !== 'err' && !/\b(?:error|failed|failure|warning|timeout|timed out|exception|disconnect|could not|cannot|diagnostics-unavailable)\b/i.test(line.text)) continue;
    issues.push({ id: `console-${index}`, at: line.ts, severity: /warning/i.test(line.text) ? 'warning' : 'error',
      category: 'console', stage: 'run', message: String(safeCaptchaDiagnostic(line.text).message ?? '') });
  }
  return { runId, issues: issues.sort((a,b) => a.at.localeCompare(b.at)), attempts: [...attempts.values()],
    structured: unique.length > 0, retentionDays: TRACE_RETENTION_DAYS,
    note: unique.length ? 'Recovered tool errors remain listed even when submission succeeds. Open an attempt for full steps. A pending step has no recorded completion.'
      : 'This older run has console records only. Detailed errors from overwritten application traces cannot be reconstructed.' };
}

export function readRunAttempt(runId: string, directory: string, attemptId: string): unknown | null {
  if (!/^\d+$/.test(runId) || !uuid.test(attemptId)) return null;
  const file = resolve(directory, 'traces', `attempt-${attemptId}.json`);
  if (!existsSync(file) || !lstatSync(file).isFile()) return null;
  const trace = JSON.parse(readFileSync(file, 'utf8'));
  return String(trace.runStartId) === runId && trace.attemptId === attemptId ? trace : null;
}
