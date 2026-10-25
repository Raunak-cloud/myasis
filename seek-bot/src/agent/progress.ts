import type { Observation } from './observe.js';

/** Advisory evidence for the sole agent. Never replays, blocks or submits. */
export class ApplicationProgress {
  private previous?: string;
  private attempted: string[] = [];
  private unchanged = 0;
  private recentStates: string[] = [];
  private savedValues = new Map<string, string>();

  attemptedAction(description: string) { this.attempted.push(description); }

  inspect(observation: Observation): string | undefined {
    // Opening a combobox can clear its temporary search text. Retain the
    // last nonempty values so returning to the same menu after saving a new
    // answer is not mistaken for a cycle.
    let answersChanged = false;
    const occurrences = new Map<string, number>();
    for (const field of observation.fields) {
      const identity = JSON.stringify([field.section, field.label, field.kind]);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const key = `${identity}:${occurrence}`;
      const value = field.currentValue;
      if (!field.sensitive && value !== undefined && value !== '' && this.savedValues.get(key) !== value) {
        this.savedValues.set(key, value);
        answersChanged = true;
      }
    }
    if (answersChanged) this.recentStates = [];
    // Ref numbering, screenshots and dynamic document titles are not progress.
    const state = JSON.stringify({ url: observation.url, text: observation.text,
      fields: observation.fields.map(({ ref: _ref, ...field }) => field),
      actions: observation.actions.map(({ ref: _ref, fieldRef: _fieldRef, ...action }) => action) });
    const changed = state !== this.previous;
    if (changed) this.unchanged = 0;
    else if (this.attempted.length) this.unchanged++;
    this.previous = state;
    const attempts = this.attempted.splice(0);
    if (!attempts.length) {
      if (!this.recentStates.length) this.recentStates.push(state);
      return;
    }
    const visits = this.recentStates.filter(prior => prior === state).length + 1;
    this.recentStates.push(state);
    if (this.recentStates.length > 8) this.recentStates.shift();
    if (changed && visits >= 3) return `Repeated form cycle: returned to the same saved state ${visits} times within the last 8 action turns. Last attempted: ${attempts.join('; ')}. Switching views without saving different answers is not progress. Stop repeating this cycle; inspect the purpose of the controls, required fields and validation, and choose a different way forward. Do not recreate optional history already covered by the attached CV. You still decide how to recover and whether the employer received the application.`;
    if (this.unchanged < 2) return;
    return `No visible progress after ${this.unchanged} consecutive action turns. Last attempted: ${attempts.join('; ')}. Do not repeat the same rejected action or batch. Inspect the actual widget, saved values and validation with a focused snapshot/screenshot; choose a different interaction or consult the read-only specialist. You still decide how to recover and whether the employer received the application.`;
  }
}
