import { REPAIR_EDITABLE_FILES, type RepairProposal } from './repair-coder.js';

const protectedLine = /\b(?:approved|sensitive|privateKind|credential|redact|mask|submission|sends_application|confirmation|owner|realpath|relative\(|isAbsolute|\.\.\b)/i;
const privileged = /\b(?:import|require|process|globalThis|eval|Function|fetch|WebSocket|child_process|execFile|spawn|createConnection|writeFile|appendFile|readFile|unlink|rmSync|chmod|chown)\b/;

/** Conservative admission gate before independent review and sandbox tests.
 * Existing security-related lines cannot disappear; new I/O or imports require
 * operator development outside this bounded pilot. */
export function validateRepairProposal(source: Record<string, string>, proposal: RepairProposal): void {
  const paths = Object.keys(proposal.files);
  if (!paths.length || paths.length > 3) throw Error('Repair changes too many files.');
  let changes = 0;
  for (const path of paths) {
    if (!(REPAIR_EDITABLE_FILES as readonly string[]).includes(path) || typeof source[path] !== 'string') throw Error('Repair path is not allowed.');
    const before = source[path], after = proposal.files[path];
    if (typeof after !== 'string' || after.length > 150_000 || before === after) throw Error('Invalid repair content.');
    const oldLines = before.split('\n'), newLines = after.split('\n');
    const remaining = [...newLines];
    for (const line of oldLines.filter(line => protectedLine.test(line) || privileged.test(line))) {
      const at = remaining.indexOf(line);
      if (at < 0) throw Error('Repair modifies a protected source line.');
      remaining.splice(at, 1);
    }
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    for (const line of newLines) {
      const n = oldCounts.get(line) ?? 0;
      if (n) oldCounts.set(line, n - 1);
      else { changes++; if (privileged.test(line)) throw Error('Repair introduces privileged operations.'); }
    }
    changes += [...oldCounts.values()].reduce((a,b) => a+b, 0);
  }
  if (changes > 100) throw Error('Repair is too large for automatic release.');
}

export function traceProvesNoSend(trace: Record<string, any>, runId: string, attemptId: string): boolean {
  if (String(trace.runStartId) !== runId || trace.attemptId !== attemptId || trace.outcome?.status !== 'skipped'
    || trace.sendAudit?.attempted !== false || !Array.isArray(trace.steps) || !trace.steps.length) return false;
  for (const step of trace.steps) {
    if (!step.completedAt) return false;
    const commands = step.tool === 'browser_batch' ? step.args?.actions : step.tool === 'browser_action' ? [step.args] : [];
    if (!Array.isArray(commands)) return false;
    for (const command of commands) {
      if (!command || command.sends_application === true || ['script','press','mouse_click'].includes(command.action)
        || command.x !== undefined || command.y !== undefined) return false;
      if (command.action === 'click' && command.sends_application !== false) return false;
      if (command.action === 'navigate' && command.value !== trace.job?.url) return false;
    }
    if (/\b(?:submit|send|finalise|finalize)\b/i.test(step.label ?? '') && step.tool !== 'prepare_application') return false;
    if (step.tool === 'send_email_application') return false;
  }
  return true;
}
