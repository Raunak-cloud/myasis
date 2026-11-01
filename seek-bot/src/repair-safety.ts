export function traceProvesNoSend(trace: Record<string, any>, runId: string, attemptId: string): boolean {
  if (String(trace.runStartId) !== runId || trace.attemptId !== attemptId || trace.outcome?.status !== 'skipped'
    || trace.sendAudit?.attempted !== false || !Array.isArray(trace.steps) || !trace.steps.length) return false;
  for (const step of trace.steps) {
    if (!step.completedAt) return false;
    if (step.disposition === 'not-executed') continue;
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
