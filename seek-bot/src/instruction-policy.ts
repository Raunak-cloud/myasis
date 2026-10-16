export type InstructionInjectionSource = 'instruction-check' | 'exception-review' | 'exception-correction';
export interface InstructionVerdict {
  decision: 'allow' | 'skip' | 'uncertain';
  conflict: string;
  because: string;
  checks: unknown[];
  /** Preserve the checker security signal independently of rule/exception prose. */
  injectionSuspected: boolean;
  injectionSources: InstructionInjectionSource[];
}

interface InstructionValidation {
  verdict: InstructionVerdict | null;
  error?: string;
}

/** The model judges meaning; this validates its evidence and preserves its restrictive verdicts. */
export function validateInstructionVerdict(value: unknown, rules: string, source: InstructionInjectionSource = 'instruction-check'): InstructionValidation {
  const invalid = (error: string): InstructionValidation => ({ verdict: null, error });
  if (!value || typeof value !== 'object') return invalid('response must be an object');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.checks) || !raw.checks.length) return invalid('checks must contain at least one instruction check');
  if (typeof raw.injectionSuspected !== 'boolean') return invalid('injectionSuspected must be a boolean');
  const canonical = (text: string) => text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const quotesRule = (text: unknown): text is string => typeof text === 'string' && Boolean(canonical(text)) && canonical(rules).includes(canonical(text));
  const findings: Array<{ status: 'satisfied' | 'violated' | 'uncertain'; quote: string; reason: string }> = [];
  for (const [index, item] of raw.checks.entries()) {
    const path = `checks[${index}]`;
    if (!item || typeof item !== 'object') return invalid(`${path} must be an object`);
    const check = item as Record<string, unknown>;
    if (!quotesRule(check.ruleQuote)) return invalid(`${path}.ruleQuote must quote the candidate's rules verbatim`);
    if (!['satisfied', 'violated', 'uncertain'].includes(String(check.status))) return invalid(`${path}.status must be satisfied, violated or uncertain`);
    if (typeof check.reason !== 'string' || !check.reason.trim()) return invalid(`${path}.reason must explain the listing evidence`);
    if (typeof check.exceptionQuote !== 'string') return invalid(`${path}.exceptionQuote must be a string, empty when no exception is used`);
    if (!Array.isArray(check.exceptionConditions)) return invalid(`${path}.exceptionConditions must be an array`);
    let status = check.status as 'satisfied' | 'violated' | 'uncertain';
    let reason = check.reason;
    if (check.exceptionQuote) {
      if (!quotesRule(check.exceptionQuote)) return invalid(`${path}.exceptionQuote must quote the candidate's rules verbatim`);
      if (!check.exceptionConditions.length) return invalid(`${path}.exceptionConditions must include the exception's limiting conditions`);
      for (const [conditionIndex, item] of check.exceptionConditions.entries()) {
        const conditionPath = `${path}.exceptionConditions[${conditionIndex}]`;
        if (!item || typeof item !== 'object') return invalid(`${conditionPath} must be an object`);
        const condition = item as Record<string, unknown>;
        if (!quotesRule(condition.conditionQuote) || !canonical(check.exceptionQuote).includes(canonical(condition.conditionQuote))) {
          return invalid(`${conditionPath}.conditionQuote must be a verbatim part of exceptionQuote and the candidate's rules`);
        }
        if (!['met', 'not-met', 'unclear'].includes(String(condition.status))) return invalid(`${conditionPath}.status must be met, not-met or unclear`);
        if (typeof condition.jobEvidence !== 'string' || !condition.jobEvidence.trim()) {
          return invalid(`${conditionPath}.jobEvidence must explain the listing evidence, or what is missing when unclear`);
        }
      }
      const contradicted = check.exceptionConditions.find(item => item.status === 'not-met');
      const unresolved = check.exceptionConditions.find(item => item.status === 'unclear');
      if (contradicted) { status = 'violated'; reason = `Exception condition "${contradicted.conditionQuote}" is not met: ${contradicted.jobEvidence}`; }
      else if (status !== 'violated' && unresolved) { status = 'uncertain'; reason = `Exception condition "${unresolved.conditionQuote}" is unclear: ${unresolved.jobEvidence}`; }
    } else if (check.exceptionConditions.length) return invalid(`${path}.exceptionConditions must be empty when exceptionQuote is empty`);
    findings.push({ status, quote: check.ruleQuote, reason });
  }
  const failure = findings.find(item => item.status === 'violated');
  const uncertain = findings.find(item => item.status === 'uncertain');
  return { verdict: {
    decision: failure ? 'skip' : uncertain || raw.injectionSuspected ? 'uncertain' : 'allow',
    conflict: failure?.quote ?? '',
    because: failure?.reason ?? uncertain?.reason ?? (raw.injectionSuspected ? 'Untrusted listing instructions require review.' : findings.map(item => item.reason).join(' ')),
    checks: raw.checks,
    injectionSuspected: raw.injectionSuspected,
    injectionSources: raw.injectionSuspected ? [source] : [],
  } };
}

export function normalizeInstructionVerdict(value: unknown, rules: string): InstructionVerdict | null {
  return validateInstructionVerdict(value, rules).verdict;
}
