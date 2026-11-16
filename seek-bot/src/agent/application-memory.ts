import { InteractionMemory } from './interaction-memory.js';
import type { FormField } from '../types.js';

/** Agent-authored notes and observed failures for this application only.
 * No phases, prescribed actions, report requirements or progress credits. */
export class ApplicationMemory {
  private note = '';
  private readonly failures = new InteractionMemory();
  remember(note: string): void { this.note = note.slice(-6000); }
  failed(tool: string, args: Record<string, unknown>, url: string, error: string): void {
    this.failures.failed(tool, args, url, error);
  }
  render(fields: FormField[]): string {
    const ordinary = fields.filter(field => !field.sensitive && !field.privateKind && field.inputType !== 'password');
    const label = (field: FormField) => `${field.ref}: ${field.label}`.slice(0, 140);
    const withValues = ordinary.filter(field => field.currentValue?.trim() && !field.validationError).slice(0, 12).map(label);
    const unresolved = ordinary.filter(field => field.validationError || field.required && !field.currentValue?.trim()).slice(0, 12).map(label);
    return `APPLICATION MEMORY (evidence, not restrictions)\n${JSON.stringify({
      note: this.note.slice(-1200), currentFieldsWithValues: withValues, currentRequiredOrInvalidFields: unresolved,
    })}\n${this.failures.render()}`;
  }
  checkpoint() { return { version: 2, note: this.note, failedInteractions: this.failures.checkpoint() }; }
  restore(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const saved = value as { note?: string; failedInteractions?: ReturnType<InteractionMemory['checkpoint']> };
    if (typeof saved.note === 'string') this.remember(saved.note);
    if (Array.isArray(saved.failedInteractions)) this.failures.restore(saved.failedInteractions);
  }
}
