/** One annual base-salary amount, shared by setup and the server's run gate. */
export function annualSalaryAmount(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const amount = value.trim().replace(/^(?:AUD\s*|A\$\s*|\$\s*)/i, '');
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*k?$/i.test(amount)) return null;
  const salary = Number(amount.replace(/[,\s]/g, '').replace(/k$/i, '')) * (/k$/i.test(amount) ? 1000 : 1);
  return Number.isFinite(salary) && salary >= 1 && salary <= Number.MAX_SAFE_INTEGER ? salary : null;
}

export const EXPECTED_SALARY_REQUIRED =
  'Add your expected annual base salary as a number in Setup > Your details before starting a run. Use AUD, excluding superannuation.';
