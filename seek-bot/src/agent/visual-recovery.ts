import { createHash } from 'node:crypto';
import type { Observation } from './observe.js';

/** Evidence and escalation only. Never filters tools or blocks an action. */
export class VisualRecovery {
  private fingerprint = '';
  private unchanged = 0;
  private errors = 0;
  private reviewed = false;
  private captureFailures = 0;
  private newEvidence = false;
  private evidence = new Set<string>();
  private history: { tool: string; action?: string; disposition: string; result: string }[] = [];
  private cause = '';

  record(tool: string, action: unknown, disposition: string | undefined, result: string) {
    const failed = disposition === 'failed' || disposition === 'invalid-arguments';
    this.errors = failed ? this.errors + 1 : 0;
    if (failed) this.cause = result.split('\n')[0].slice(0, 600);
    this.history.push({ tool, action: typeof action === 'string' ? action : undefined, disposition: disposition || 'completed', result: result.slice(0, 700) });
    this.history = this.history.slice(-6);
    if (['read_candidate_evidence', 'read_browser_experience'].includes(tool) && !failed) {
      const hash = createHash('sha256').update(result).digest('hex');
      if (!this.evidence.has(hash)) this.newEvidence = true;
      this.evidence.add(hash);
    }
  }

  observe(observation: Observation) {
    // Ignore ephemeral refs/identities, screenshots and private values. Retain
    // actual field/option/validation, popup and rendered-page changes.
    const next = JSON.stringify({ url: observation.url, title: observation.title,
      text: (observation.surfaceText || observation.text).replace(/\s+/g, ' ').trim(), dialogs: observation.dialogs,
      error: observation.inspectionError,
      fields: observation.fields.map(field => ({ label: field.label, section: field.section, kind: field.kind,
        value: field.sensitive || field.privateKind || field.inputType === 'password' ? '[private]' : field.currentValue,
        required: field.required, validation: field.validationError, options: field.options, selection: field.selectionState, status: field.optionStatusText, disabled: field.disabled })),
      actions: observation.actions.map(action => ({ text: action.text, role: action.role, disabled: action.disabled, selected: action.selected })) });
    const progress = Boolean(this.fingerprint && (this.fingerprint !== next || this.newEvidence));
    if (progress) { this.unchanged = 0; this.reviewed = false; this.cause = ''; }
    else if (this.fingerprint) this.unchanged++;
    this.fingerprint = next;
    this.newEvidence = false;
    const stalled = this.errors >= 2 || this.unchanged >= 3;
    const fields = [...new Set(observation.fields.filter(field => field.validationError || field.required && !field.currentValue && !field.disabled).map(field => field.label))];
    const cause = this.cause || `The page and saved field values did not change.${fields.length ? ` Unresolved fields: ${fields.slice(0, 8).join(', ')}.` : ''}`;
    return { screenshot: stalled && !this.reviewed, stop: stalled && this.reviewed || this.captureFailures >= 2, captureUnavailable: this.captureFailures >= 2,
      cause, note: `VISUAL RECOVERY: ${cause}\nRecent action results (historical evidence): ${JSON.stringify(this.history)}\nInspect the attached FRESH screenshot alongside current page controls and validation. Identify why prior actions failed and choose a different evidence-supported approach. Normal tools remain available; no action is locked. Do not repeat a possible send. If the screenshot was unavailable, do not claim to have seen it.` };
  }

  screenshotCaptured(success: boolean) {
    if (success) { this.reviewed = true; this.unchanged = 0; this.errors = 0; this.captureFailures = 0; }
    else this.captureFailures++;
  }
}
