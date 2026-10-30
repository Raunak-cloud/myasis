/** Versioned usage journal DTO; no candidate data or provider credentials. */
export interface UsageEvent {
  id: string; runId: string; at: string; jobId?: string;
  kind: 'usage' | 'submitted' | 'started' | 'finished';
  provider?: string; model?: string; amountUsd?: number | null;
  basis?: 'provider' | 'estimated' | 'unknown'; detail?: string; quantity?: number; unit?: string;
}
interface CostLine {
  provider: string; model?: string; allocation: 'direct' | 'shared';
  amountUsd: number; knownCharges: number; unknownCharges: number;
  calls: number; details: string[];
}
export interface ApplicationCost {
  currency: 'USD'; totalUsd: number; knownCharges: number; incomplete: boolean;
  lines: CostLine[]; notes: string[];
}

/** Submission costs belong to the latest confirmed submission run, not every
 * historical attempt at the listing. Shared allocation keeps its original
 * denominator even when another job now has a more recent submission run.
 * Retired-provider records stay in the ledger but are excluded from this view. */
export function summariseApplicationCosts(events: UsageEvent[], unconfirmed: ReadonlySet<string> = new Set()): Record<string, ApplicationCost> {
  const runs = new Map<string, UsageEvent[]>();
  const seen = new Set<string>();
  const submissions = new Map<string, { runId: string; at: string }>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const run = runs.get(event.runId) ?? []; run.push(event); runs.set(event.runId, run);
    if (event.kind === 'submitted' && event.jobId && !unconfirmed.has(event.jobId)) {
      const previous = submissions.get(event.jobId);
      if (!previous || Date.parse(event.at) > Date.parse(previous.at)) submissions.set(event.jobId, event);
    }
  }
  const result: Record<string, ApplicationCost> = Object.create(null);
  for (const run of runs.values()) {
    const submitted = new Set(run.filter(e => e.kind === 'submitted' && e.jobId && !unconfirmed.has(e.jobId)).map(e => e.jobId!));
    const recipients = submitted.size ? submitted : new Set(run.filter(e => e.kind === 'usage' && e.jobId).map(e => e.jobId!));
    const finished = run.some(e => e.kind === 'finished');
    for (const e of run) {
      if (e.kind !== 'usage') continue;
      const direct = Boolean(e.jobId && recipients.has(e.jobId));
      const targets = direct ? [e.jobId!] : [...recipients];
      for (const jobId of targets) {
        if (submissions.has(jobId) && submissions.get(jobId)!.runId !== e.runId) continue;
        const cost = result[jobId] ??= { currency: 'USD', totalUsd: 0, knownCharges: 0, incomplete: false, lines: [], notes: [] };
        if (/anthropic/i.test(e.provider ?? '') || /haiku/i.test(e.model ?? '')) {
          cost.incomplete = true;
          const note = 'Retired-provider charges are excluded from this view; historical billing records are retained.';
          if (!cost.notes.includes(note)) cost.notes.push(note);
          continue;
        }
        const allocation = direct ? 'direct' : 'shared';
        let line = cost.lines.find(l => l.provider === e.provider && l.model === e.model && l.allocation === allocation);
        if (!line) { line = { provider: e.provider ?? 'Other', model: e.model, allocation, amountUsd: 0, knownCharges: 0, unknownCharges: 0, calls: 0, details: [] }; cost.lines.push(line); }
        line.calls++;
        if (typeof e.amountUsd === 'number' && Number.isFinite(e.amountUsd) && e.amountUsd >= 0) {
          const amount = e.amountUsd / targets.length;
          line.amountUsd += amount; cost.totalUsd += amount; line.knownCharges++; cost.knownCharges++;
        } else { line.unknownCharges++; cost.incomplete = true; }
        if (e.detail && !line.details.includes(e.detail) && line.details.length < 4) line.details.push(e.detail);
        if (!finished) { cost.incomplete = true; if (!cost.notes.includes('Run has not closed cleanly; final costs may be missing.')) cost.notes.push('Run has not closed cleanly; final costs may be missing.'); }
      }
    }
  }
  for (const [jobId, cost] of Object.entries(result)) {
    cost.notes.push(submissions.has(jobId)
      ? 'Costs shown are from the submission run; earlier attempts are excluded.'
      : 'No submission run is recorded; showing available attempt costs.');
    cost.notes.push('USD estimates before provider credits, tax and invoice adjustments.');
    if (cost.lines.some(l => l.allocation === 'shared')) cost.notes.push('Shared: equal share of search, ranking and unsuccessful attempts in this run. Runs with no submissions retain costs against reviewed jobs.');
  }
  return result;
}

export const formatApplicationCost = (cost?: ApplicationCost): string => !cost ? 'Not recorded'
  : !cost.knownCharges ? 'Unavailable' : `US$${cost.totalUsd.toFixed(4)}${cost.incomplete ? ' +' : ''}`;
