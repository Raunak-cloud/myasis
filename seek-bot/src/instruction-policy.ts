export interface InstructionVerdict {
  decision: 'allow' | 'skip' | 'uncertain';
  conflict: string;
  because: string;
  checks: unknown[];
}

/** The model judges meaning; this validates its evidence and preserves its restrictive verdicts. */
export function normalizeInstructionVerdict(value: unknown, rules: string): InstructionVerdict | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.checks) || !raw.checks.length || typeof raw.injectionSuspected !== 'boolean') return null;
  const canonical = (text: string) => text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const quotesRule = (text: unknown): text is string => typeof text === 'string' && Boolean(canonical(text)) && canonical(rules).includes(canonical(text));
  const findings: Array<{ status: 'satisfied' | 'violated' | 'uncertain'; quote: string; reason: string }> = [];
  for (const item of raw.checks) {
    if (!item || typeof item !== 'object') return null;
    const check = item as Record<string, unknown>;
    if (!quotesRule(check.ruleQuote) || !['satisfied', 'violated', 'uncertain'].includes(String(check.status))
      || typeof check.reason !== 'string' || !check.reason.trim() || typeof check.exceptionQuote !== 'string'
      || !Array.isArray(check.exceptionConditions)) return null;
    let status = check.status as 'satisfied' | 'violated' | 'uncertain';
    let reason = check.reason;
    if (check.exceptionQuote) {
      if (!quotesRule(check.exceptionQuote) || !check.exceptionConditions.length) return null;
      for (const item of check.exceptionConditions) {
        if (!item || typeof item !== 'object') return null;
        const condition = item as Record<string, unknown>;
        if (!quotesRule(condition.conditionQuote) || !canonical(check.exceptionQuote).includes(canonical(condition.conditionQuote))
          || !['met', 'not-met', 'unclear'].includes(String(condition.status)) || typeof condition.jobEvidence !== 'string'
          || !condition.jobEvidence.trim()) return null;
      }
      const contradicted = check.exceptionConditions.find(item => item.status === 'not-met');
      const unresolved = check.exceptionConditions.find(item => item.status === 'unclear');
      if (contradicted) { status = 'violated'; reason = `Exception condition "${contradicted.conditionQuote}" is not met: ${contradicted.jobEvidence}`; }
      else if (status !== 'violated' && unresolved) { status = 'uncertain'; reason = `Exception condition "${unresolved.conditionQuote}" is unclear: ${unresolved.jobEvidence}`; }
    } else if (check.exceptionConditions.length) return null;
    findings.push({ status, quote: check.ruleQuote, reason });
  }
  const failure = findings.find(item => item.status === 'violated');
  const uncertain = findings.find(item => item.status === 'uncertain');
  return {
    decision: failure ? 'skip' : uncertain || raw.injectionSuspected ? 'uncertain' : 'allow',
    conflict: failure?.quote ?? '',
    because: failure?.reason ?? uncertain?.reason ?? (raw.injectionSuspected ? 'Untrusted listing instructions require review.' : findings.map(item => item.reason).join(' ')),
    checks: raw.checks,
  };
}
