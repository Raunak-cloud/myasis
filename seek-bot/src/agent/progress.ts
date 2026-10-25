import type { Observation } from './observe.js';

/** Advisory evidence for the sole agent. Never replays, blocks or submits. */
export class ApplicationProgress {
  private previous?: string;
  private attempted: string[] = [];
  private unchanged = 0;

  attemptedAction(description: string) { this.attempted.push(description); }

  inspect(observation: Observation): string | undefined {
    // Ref numbering, screenshots and dynamic document titles are not progress.
    const state = JSON.stringify({ url: observation.url, text: observation.text,
      fields: observation.fields.map(({ ref: _ref, ...field }) => field),
      actions: observation.actions.map(({ ref: _ref, fieldRef: _fieldRef, ...action }) => action) });
    if (state !== this.previous) this.unchanged = 0;
    else if (this.attempted.length) this.unchanged++;
    this.previous = state;
    const attempts = this.attempted.splice(0);
    if (!attempts.length || this.unchanged < 2) return;
    return `No visible progress after ${this.unchanged} consecutive action turns. Last attempted: ${attempts.join('; ')}. Do not repeat the same rejected action or batch. Inspect the actual widget, saved values and validation with a focused snapshot/screenshot; choose a different interaction or consult the read-only specialist. You still decide how to recover and whether the employer received the application.`;
  }
}
