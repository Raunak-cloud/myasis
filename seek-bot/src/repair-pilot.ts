/** Signals for the single-account coding-repair pilot. Employer text, stack
 * traces, candidate details and credentials never cross this boundary. */
export interface RepairDiagnostic {
  id?: unknown;
  runStartId?: unknown;
  attemptId?: unknown;
  severity?: unknown;
  category?: unknown;
  tool?: unknown;
  message?: unknown;
}

export interface RepairIncident {
  runId: string;
  attemptId: string;
  category: 'repeated_tool_failure' | 'application_exception';
  tool?: string;
  code?: 'approved_document_bundle_rejected' | 'target_missing' | 'target_ambiguous' | 'pointer_blocked' | 'outside_viewport' | 'question_capture_rejected' | 'tool_arguments_rejected';
  count: number;
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const TOOL = /^(?:browser_action|browser_batch|create_file|convert_file|combine_approved_documents|prepare_application|finish)$/;

/** Only the named active admin account can supply incidents to this pilot.
 * Warnings are not enough on their own: two identical tool failures within an
 * attempt are required. A fatal application exception is also actionable. */
export class RepairPilotDetector {
  private readonly counts = new Map<string, number>();
  private readonly emitted = new Set<string>();
  private readonly seen = new Set<string>();

  private readonly ownerId: string;
  private readonly ownerEmail: string;
  private readonly isActiveAdmin: boolean;
  constructor(ownerId: string, ownerEmail: string, isActiveAdmin: boolean) {
    this.ownerId = ownerId; this.ownerEmail = ownerEmail; this.isActiveAdmin = isActiveAdmin;
  }

  observe(runId: string, input: RepairDiagnostic): RepairIncident | null {
    if (this.ownerId !== '1' || this.ownerEmail.toLowerCase() !== 'raunak.vision@gmail.com' || !this.isActiveAdmin
      || !/^\d+$/.test(runId) || input.runStartId !== runId || typeof input.attemptId !== 'string' || !UUID.test(input.attemptId)
      || typeof input.id !== 'string' || !UUID.test(input.id) || this.seen.has(input.id)) return null;
    this.seen.add(input.id);
    const attemptId = input.attemptId;
    const fatal = input.category === 'application_exception' && input.severity === 'error';
    const tool = typeof input.tool === 'string' && TOOL.test(input.tool) ? input.tool : undefined;
    if (!fatal && !(input.category === 'tool_error' && input.severity === 'warning' && tool)) return null;
    const key = JSON.stringify([runId, attemptId, fatal ? 'application_exception' : tool]);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if ((!fatal && count < 2) || this.emitted.has(key)) return null;
    this.emitted.add(key);
    const message = typeof input.message === 'string' ? input.message : '';
    const code = tool === 'create_file' && typeof input.message === 'string'
      && input.message.includes('Generated content must match the candidate-approved cover letter exactly.')
      ? 'approved_document_bundle_rejected' as const
      : /outside of the viewport/i.test(message) ? 'outside_viewport' as const
      : /intercepts pointer events/i.test(message) ? 'pointer_blocked' as const
      : /strict mode violation|resolved to \d+ elements/i.test(message) ? 'target_ambiguous' as const
      : /no longer on the page|waiting for .*exceeded|Timeout .*exceeded/i.test(message) ? 'target_missing' as const
      : /employer quote is not present|complete question labels/i.test(message) ? 'question_capture_rejected' as const
      : /Invalid tool input/i.test(message) ? 'tool_arguments_rejected' as const : undefined;
    return { runId, attemptId, category: fatal ? 'application_exception' : 'repeated_tool_failure', ...(tool ? { tool } : {}), ...(code ? { code } : {}), count };
  }
}
