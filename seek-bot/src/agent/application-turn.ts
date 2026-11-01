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
 * away from the agent. Only the canonical accuracy review is mandatory.
 * Completion is a one-way, bounded, read-only lane: it cannot fund editing,
 * another specialist, or a send even if a review later earns progress credit. */
export class ApplicationTurnCoordinator {
  private completing = false;
  private records = 0;
  private decisions = 0;

  next(state: TurnState) {
    if (state.actionExhausted && (state.preparations.length || state.needsAnswer || state.submissionAttempted)) this.completing = true;
    const stopped = this.completing && (this.records >= 3 || this.decisions >= 5);
    const checkpoint = !stopped && !state.pendingDialog && state.reviewRequested ? 'record_application_review' : undefined;
    const tools = this.completing && !checkpoint && !stopped
      ? ['finish', ...(!state.needsAnswer && !state.needsCorrection && !state.submissionAttempted && this.records < 2 ? state.preparations : [])]
      : undefined;
    return { completing: this.completing, stopped, checkpoint, tools };
  }

  executed(tool: string): void {
    if (this.completing && ['finish', 'prepare_application', 'prepare_email_application'].includes(tool)) this.records++;
  }

  requested(): void { if (this.completing) this.decisions++; }
}
