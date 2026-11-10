import { InteractionMemory } from './interaction-memory.js';

/** Agent-authored notes and observed failures for this application only.
 * No phases, prescribed actions, report requirements or progress credits. */
export class ApplicationMemory {
  private note = '';
  private readonly failures = new InteractionMemory();
  remember(note: string): void { this.note = note.slice(-6000); }
  failed(tool: string, args: Record<string, unknown>, url: string, error: string): void {
    this.failures.failed(tool, args, url, error);
  }
  checkpoint() { return { version: 2, note: this.note, failedInteractions: this.failures.checkpoint() }; }
  restore(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const saved = value as { note?: string; failedInteractions?: ReturnType<InteractionMemory['checkpoint']> };
    if (typeof saved.note === 'string') this.remember(saved.note);
    if (Array.isArray(saved.failedInteractions)) this.failures.restore(saved.failedInteractions);
  }
}
