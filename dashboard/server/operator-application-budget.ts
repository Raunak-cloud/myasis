/** Bounded, run-only administrator spending authorization. USD per application. */
export interface OperatorApplicationBudget { baseUsd: number; maximumUsd: number }
export function validOperatorApplicationBudget(value: unknown): value is OperatorApplicationBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const budget = value as OperatorApplicationBudget;
  return Number.isFinite(budget.baseUsd) && Number.isFinite(budget.maximumUsd)
    && budget.baseUsd >= 0.10 && budget.maximumUsd >= budget.baseUsd && budget.maximumUsd <= 10;
}
