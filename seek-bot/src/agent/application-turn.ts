type PreparationTool = 'prepare_application' | 'prepare_email_application';
interface TurnState {
  actionExhausted: boolean;
  pendingDialog: boolean;
  reviewRequested: boolean;
  needsAnswer: boolean;
  needsCorrection: boolean;
  submissionAttempted: boolean;
  preparations: PreparationTool[];
}

/** One owner of turn precedence. Recovery/specialist advice never takes a turn
 * away from the agent. Canonical accuracy review is a self-review suggestion.
 * Completion is a one-way, bounded, read-only lane: it cannot fund editing,
 * another specialist, or a send even if a review later earns progress credit. */
export class ApplicationTurnCoordinator {
  checkpoint() { return { completing: this.completing, records: this.records, decisions: this.decisions }; }
  restore(saved: ReturnType<ApplicationTurnCoordinator['checkpoint']>): void {
    if (typeof saved.completing !== 'boolean' || !Number.isSafeInteger(saved.records) || saved.records < 0 || !Number.isSafeInteger(saved.decisions) || saved.decisions < 0) throw Error('Invalid completion checkpoint.');
    this.completing = saved.completing; this.records = saved.records; this.decisions = saved.decisions;
  }
  private completing = false;
  private records = 0;
  private decisions = 0;

  next(state: TurnState) {
    if (state.actionExhausted && (state.preparations.length || state.needsAnswer || state.submissionAttempted)) this.completing = true;
    const stopped = this.completing && (this.records >= 3 || this.decisions >= 5);
    const checkpoint = !stopped && !state.pendingDialog && state.reviewRequested ? 'record_application_review' : undefined;
    const tools = this.completing && !stopped
      ? ['finish', ...(!state.needsAnswer && !state.needsCorrection && !state.submissionAttempted && this.records < 2 ? state.preparations : []), ...(checkpoint ? [checkpoint] : [])]
      : undefined;
    return { completing: this.completing, stopped, checkpoint, tools };
  }

  executed(tool: string): void {
    if (this.completing && ['finish', 'prepare_application', 'prepare_email_application'].includes(tool)) this.records++;
  }

  requested(): void { if (this.completing) this.decisions++; }
}
