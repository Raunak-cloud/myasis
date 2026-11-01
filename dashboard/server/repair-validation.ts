import { REPAIR_EDITABLE_FILES, repairSourceText, type RepairProposal } from './repair-coder.js';
import { browserOwnershipMask } from './repair-source-policy.js';

const protectedLine = /\b(?:approved|sensitive|privateKind|credential|redact|mask|submission|sends_application|confirmation|owner|realpath|relative\(|isAbsolute|assertBrowserPage|BrowserPageContractError|BrowserTargetInputError|target_mode|coordinateTarget|\.\.\b)/i;
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
    if(typeof proposal.files[path]!=='string')throw Error('Invalid repair content.');
    const before = repairSourceText(source[path]), after = repairSourceText(proposal.files[path]);
    if (after.length > 150_000 || before === after) throw Error('Invalid repair content.');
    const oldLines = before.split('\n'), newLines = after.split('\n');
    const oldPolicy=browserOwnershipMask(before).split('\n'),newPolicy=browserOwnershipMask(after).split('\n');
    const remaining = [...newLines];
    for (const line of oldLines.filter((line,index) => protectedLine.test(oldPolicy[index]) || privileged.test(line))) {
      const at = remaining.indexOf(line);
      if (at < 0) throw Error('Repair modifies a protected source line.');
      remaining.splice(at, 1);
    }
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    for (const [index,line] of newLines.entries()) {
      const n = oldCounts.get(line) ?? 0;
      if (n) oldCounts.set(line, n - 1);
      else { changes++; if (privileged.test(line)||protectedLine.test(newPolicy[index])) throw Error('Repair introduces privileged or protected operations.'); }
    }
    changes += [...oldCounts.values()].reduce((a,b) => a+b, 0);
  }
  if (changes > 100) throw Error('Repair is too large for automatic release.');
}

export { traceProvesNoSend } from '../../seek-bot/src/repair-safety.js';
