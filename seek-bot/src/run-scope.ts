/**
 * What kind of application this run is limited to.
 *
 * A diagnostic, set per run by an operator: "employer sites only" exercises
 * the agent on employers' own forms across every board without spending
 * the run on the board-hosted forms that already work, and "board forms
 * only" the reverse. Every place that knows which kind a listing is asks
 * here, so the rule lives once.
 */
type RunScope = 'all' | 'external' | 'hosted';
type ApplicationKind = 'hosted' | 'external';

export function runScope(): RunScope {
  const value = process.env.APPLY_ONLY;
  return value === 'external' || value === 'hosted' ? value : 'all';
}

export function outsideScope(kind: ApplicationKind): boolean {
  const scope = runScope();
  return scope !== 'all' && scope !== kind;
}

export const SCOPE_LABEL: Record<RunScope, string> = {
  all: 'every application',
  external: "employer sites only (the employer's own form)",
  hosted: "board forms only (SEEK Quick Apply, Apply with Indeed)",
};

/** Plain wording for a listing skipped because of the scope. */
export function scopeSkipReason(): string {
  return runScope() === 'external'
    ? 'Outside this run: it was limited to employer-site applications.'
    : 'Outside this run: it was limited to board-hosted applications.';
}
